"use client";

import { useState, useRef } from "react";
import { OpeningManagementSettlementPanel } from "./OpeningManagementSettlementPanel";
import { PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED, PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE } from "@/convex/utils/partnerDistributionContainment";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type * as z from "zod";
import { usePaginatedQuery, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { partnerEquityNeedsBank } from "@/convex/utils/partnerEquityBank";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { toast } from "@/components/ui/sonner";
import { Plus, History, ArrowDownToLine, ArrowUpFromLine, PieChart, Loader2 } from "lucide-react";
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
  scaleForCurrency,
  useAccountingSubmit,
  type CurrencyFormatter,
} from "./AccountingTabShared";
import { addPartnerSchema, type AddPartnerFormValues, movementSchema, type MovementFormValues } from "./partnerEquity.schema";

type MovementType = "CONTRIBUTION" | "DRAW" | "PROFIT_DISTRIBUTION";

type PartnerRow = NonNullable<
  ReturnType<typeof usePaginatedQuery<typeof api.partnerEquity.list>>["results"]
>[number];

type PartnerBankOptions = {
  banks: Array<{ _id: Id<"bankAccounts">; name: string; currency: string }>;
  truncated: boolean;
} | undefined;

function selectedBank(options: PartnerBankOptions, id: string | undefined) {
  return options?.banks.find((bank) => bank._id === id);
}

function PartnerBankChoice({
  inputId, value, onChange, options, direction, t,
}: Readonly<{
  inputId: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: PartnerBankOptions;
  direction: "IN" | "OUT";
  t: ReturnType<typeof useLanguage>["t"];
}>) {
  const eligible = selectedBank(options, value);
  const unavailable = options?.truncated === true;
  const empty = options !== undefined && !unavailable && options.banks.length === 0;
  const label = direction === "IN" ? "ReceiptBankAccount" : "DirectPaymentBankLabel";
  const choose = direction === "IN" ? "ReceiptSelectBank" : "DirectPaymentBankChoose";
  const message = unavailable
    ? direction === "IN" ? "ReceiptTooManyBanks" : "DirectPaymentTooManyBanks"
    : empty ? direction === "IN" ? "ReceiptNoBank" : "DirectPaymentNoBank" : null;
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">{t(label)}</label>
      <select
        id={inputId}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
        value={eligible?._id ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        disabled={options === undefined || unavailable || empty}
        required
        aria-describedby={message ? `${inputId}-status` : undefined}
      >
        <option value="">{t(options === undefined ? "CashDrawerLoadingBanks" : choose)}</option>
        {(options?.banks ?? []).map((bank) => (
          <option key={bank._id} value={bank._id}>{bank.name} · {bank.currency}</option>
        ))}
      </select>
      {message && <p id={`${inputId}-status`} className="text-sm text-muted-foreground" role="status">{t(message)}</p>}
    </div>
  );
}

const MOVEMENT_META: Record<MovementType, { titleKey: string; descKey: string; needsPayment: boolean }> = {
  CONTRIBUTION: { titleKey: "RecordContribution", descKey: "RecordContributionDesc", needsPayment: true },
  DRAW: { titleKey: "RecordDraw", descKey: "RecordDrawDesc", needsPayment: true },
  PROFIT_DISTRIBUTION: { titleKey: "RecordDistribution", descKey: "RecordDistributionDesc", needsPayment: false },
};

export function PartnerEquityTab() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const { code: currencyCode } = useCurrency();
  const formatCurrency = useCurrencyFormatter();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const scale = scaleForCurrency(currencyCode);
  const factor = Math.pow(10, scale);

  const { results: partners, status: partnersStatus, loadMore: loadMorePartners } = usePaginatedQuery(
    api.partnerEquity.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const [addOpen, setAddOpen] = useState(false);
  const [movement, setMovement] = useState<{ partner: PartnerRow; type: MovementType } | null>(null);
  const [historyPartner, setHistoryPartner] = useState<PartnerRow | null>(null);
  const bankOptions = useQuery(
    api.partnerEquity.listBankOptions,
    activeOrgId && canManage && (addOpen || movement) ? { orgId: activeOrgId } : "skip"
  );

  if (partnersStatus === "LoadingFirstPage") {
    return <LoadingAccountingState label={t("LoadingEquity" as any)} />;
  }

  return (
    <div className="p-6 space-y-6">
      {activeOrgId && <OpeningManagementSettlementPanel orgId={activeOrgId} />}
      <div className="mb-2 flex justify-between items-center gap-4 flex-wrap">
        <h2 className="text-lg font-semibold text-foreground">{t("PartnerEquity" as any)}</h2>
        {canManage && (
          <Button size="sm" className="gap-2" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4" />
            {t("AddPartner" as any)}
          </Button>
        )}
      </div>

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("PartnerName" as any)}</TableHead>
              <TableHead className="text-right">{t("CurrentBalance" as any)}</TableHead>
              <TableHead>{t("NotesLabel" as any)}</TableHead>
              <TableHead className="text-right">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {partners.length === 0 ? (
              <AccountingEmptyRow colSpan={4} label={t("NoEquityFound" as any)} />
            ) : (
              partners.map((partner) => {
                const hasLegacyBase = (partner.currentBalance ?? 0) !== 0 || (partner.initialCapital ?? 0) !== 0;
                return (
                  <TableRow key={partner._id}>
                    <TableCell className="font-medium">{partner.partnerName}</TableCell>
                    <TableCell className="text-right">
                      <span className="font-semibold text-foreground">
                        {partner.balanceMinor === null ? t("FigureUnavailable") : formatCurrency(partner.balanceMinor / factor, scale)}
                      </span>
                      {hasLegacyBase && (
                        <Badge variant="outline" className="ms-2 text-muted-foreground" title={t("LegacyBalanceNotice" as any)}>
                          {t("AssetStatusLegacy" as any)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{partner.notes || "-"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("PartnerHistory" as any)}
                          aria-label={t("PartnerHistory" as any)}
                          onClick={() => setHistoryPartner(partner)}
                        >
                          <History className="w-4 h-4 text-muted-foreground" />
                        </Button>
                        {canManage && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("RecordContribution" as any)}
                              aria-label={t("RecordContribution" as any)}
                              onClick={() => setMovement({ partner, type: "CONTRIBUTION" })}
                              disabled={partner.balanceStatus !== "VERIFIED"}
                            >
                              <ArrowDownToLine className="w-4 h-4 text-emerald-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("RecordDraw" as any)}
                              aria-label={t("RecordDraw" as any)}
                              onClick={() => setMovement({ partner, type: "DRAW" })}
                              disabled={partner.balanceStatus !== "VERIFIED"}
                            >
                              <ArrowUpFromLine className="w-4 h-4 text-rose-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED ? PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE[locale] : t("RecordDistribution" as any)}
                              aria-label={PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED ? PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE[locale] : t("RecordDistribution" as any)}
                              onClick={() => setMovement({ partner, type: "PROFIT_DISTRIBUTION" })}
                              disabled={PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED || partner.balanceStatus !== "VERIFIED"}
                            >
                              <PieChart className="w-4 h-4 text-violet-600" />
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
      </AccountingTableFrame>

      {partnersStatus === "CanLoadMore" && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => loadMorePartners(75)}>
            {t("LoadMore" as any)}
          </Button>
        </div>
      )}

      {activeOrgId && canManage && (
        <AddPartnerDialog open={addOpen} onOpenChange={setAddOpen} orgId={activeOrgId} factor={factor} bankOptions={bankOptions} />
      )}

      {activeOrgId && movement && (
        <MovementDialog
          partner={movement.partner}
          type={movement.type}
          onOpenChange={(open) => !open && setMovement(null)}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
          formatCurrency={formatCurrency}
          bankOptions={bankOptions}
        />
      )}

      {activeOrgId && (
        <PartnerHistoryDialog
          partner={historyPartner}
          onOpenChange={(open) => !open && setHistoryPartner(null)}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
          formatCurrency={formatCurrency}
        />
      )}
    </div>
  );
}

function AddPartnerDialog({
  open,
  onOpenChange,
  orgId,
  factor,
  bankOptions,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  bankOptions: PartnerBankOptions;
}>) {
  const { t } = useLanguage();
  const addPartner = useMutation(api.partnerEquity.add);
  // Minted at the user-intent boundary and held across attempts — a key minted
  // per attempt would let a lost response create a second partner and a second
  // opening-capital posting.
  const idempotencyKeyRef = useRef<string | null>(null);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const form = useForm<z.input<typeof addPartnerSchema>, unknown, AddPartnerFormValues>({
    resolver: zodResolver(addPartnerSchema),
    defaultValues: { name: "", openingContribution: 0, paymentMethod: "CASH", bankAccountId: undefined, notes: "" },
  });
  const openingAmount = form.watch("openingContribution");
  const paymentMethod = form.watch("paymentMethod");
  const bankSelection = form.watch("bankAccountId");
  const needsBank = Number(openingAmount) > 0 && partnerEquityNeedsBank("CONTRIBUTION", paymentMethod);

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) form.reset();
  }

  async function onSubmit(values: AddPartnerFormValues) {
    const openingMinor = Math.round(values.openingContribution * factor);
    const requiresBank = openingMinor > 0 && partnerEquityNeedsBank("CONTRIBUTION", values.paymentMethod);
    const bank = requiresBank ? selectedBank(bankOptions, values.bankAccountId) : undefined;
    if (requiresBank && !bank) {
      form.setError("bankAccountId", { message: t("ReceiptSelectBank") });
      return;
    }
    await submitWithFeedback(async () => {
      idempotencyKeyRef.current ??= `partner-add:${crypto.randomUUID()}`;
      await addPartner({
        idempotencyKey: idempotencyKeyRef.current,
        orgId,
        partnerName: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        openingContributionMinor: openingMinor > 0 ? openingMinor : undefined,
        paymentMethod: openingMinor > 0 ? values.paymentMethod : undefined,
        bankAccountId: bank?._id,
      });
      // Only a SUCCESS retires the identity.
      idempotencyKeyRef.current = null;
      toast.success(t("PartnerAdded" as any));
      handleOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("AddPartner" as any)}</DialogTitle>
          <DialogDescription>{t("AddPartnerDesc" as any)}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("PartnerName" as any)}</FormLabel>
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
                name="openingContribution"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("OpeningContributionLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step={1 / factor} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="paymentMethod"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("PaymentMethodLabel" as any)}</FormLabel>
                    <FormControl>
                      <PaymentMethodSelect t={t} value={field.value} onValueChange={(value) => {
                        field.onChange(value);
                        form.setValue("bankAccountId", undefined);
                        form.clearErrors("bankAccountId");
                      }} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {needsBank && (
              <>
                <PartnerBankChoice
                  inputId="partner-add-bank"
                  value={bankSelection}
                  onChange={(value) => {
                    form.setValue("bankAccountId", value);
                    form.clearErrors("bankAccountId");
                  }}
                  options={bankOptions}
                  direction="IN"
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
                    <Textarea {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <DialogFooterActions
                cancelLabel={t("Cancel" as any)}
                confirmLabel={t("AddPartner" as any)}
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

function MovementDialog({
  partner,
  type,
  onOpenChange,
  orgId,
  factor,
  scale,
  formatCurrency,
  bankOptions,
}: Readonly<{
  partner: PartnerRow;
  type: MovementType;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
  bankOptions: PartnerBankOptions;
}>) {
  const { t } = useLanguage();
  const recordMovement = useMutation(api.partnerEquity.recordEquityMovement);
  const idempotencyKeyRef = useRef<string | null>(null);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const meta = MOVEMENT_META[type];

  const form = useForm<z.input<typeof movementSchema>, unknown, MovementFormValues>({
    resolver: zodResolver(movementSchema),
    defaultValues: { amount: 0, paymentMethod: "CASH", bankAccountId: undefined, notes: "" },
  });
  const paymentMethod = form.watch("paymentMethod");
  const bankSelection = form.watch("bankAccountId");
  const needsBank = partnerEquityNeedsBank(type, paymentMethod);

  async function onSubmit(values: MovementFormValues) {
    const requiresBank = partnerEquityNeedsBank(type, values.paymentMethod);
    const bank = requiresBank ? selectedBank(bankOptions, values.bankAccountId) : undefined;
    if (requiresBank && !bank) {
      form.setError("bankAccountId", { message: t(type === "CONTRIBUTION" ? "ReceiptSelectBank" : "DirectPaymentBankRequired") });
      return;
    }
    await submitWithFeedback(async () => {
      idempotencyKeyRef.current ??= `equity-movement:${crypto.randomUUID()}`;
      await recordMovement({
        idempotencyKey: idempotencyKeyRef.current,
        orgId,
        partnerId: partner._id,
        type,
        amountMinor: Math.round(values.amount * factor),
        paymentMethod: meta.needsPayment ? values.paymentMethod : undefined,
        bankAccountId: bank?._id,
        notes: values.notes?.trim() || undefined,
      });
      // Only a SUCCESS retires the identity.
      idempotencyKeyRef.current = null;
      toast.success(t("EquityMovementRecorded" as any));
      onOpenChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(meta.titleKey as any)}</DialogTitle>
          <DialogDescription>{partner.partnerName} — {t(meta.descKey as any)}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
            <AmountSummary
              label={t("CurrentBalance" as any)}
              value={partner.balanceMinor === null ? t("FigureUnavailable") : formatCurrency(partner.balanceMinor / factor, scale)}
            />

            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("AmountLabel" as any)}</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} step={1 / factor} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {meta.needsPayment && (
              <FormField
                control={form.control}
                name="paymentMethod"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("PaymentMethodLabel" as any)}</FormLabel>
                    <FormControl>
                      <PaymentMethodSelect t={t} value={field.value} onValueChange={(value) => {
                        field.onChange(value);
                        form.setValue("bankAccountId", undefined);
                        form.clearErrors("bankAccountId");
                      }} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {needsBank && (
              <>
                <PartnerBankChoice
                  inputId="partner-movement-bank"
                  value={bankSelection}
                  onChange={(value) => {
                    form.setValue("bankAccountId", value);
                    form.clearErrors("bankAccountId");
                  }}
                  options={bankOptions}
                  direction={type === "CONTRIBUTION" ? "IN" : "OUT"}
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
                    <Textarea {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <DialogFooterActions
                cancelLabel={t("Cancel" as any)}
                confirmLabel={t(meta.titleKey as any)}
                onCancel={() => onOpenChange(false)}
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

function PartnerHistoryDialog({
  partner,
  onOpenChange,
  orgId,
  factor,
  scale,
  formatCurrency,
}: Readonly<{
  partner: PartnerRow | null;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
}>) {
  const { t } = useLanguage();
  const transactions = useQuery(
    api.partnerEquity.listTransactions,
    partner ? { orgId, partnerId: partner._id } : "skip"
  );
  const body = transactions === undefined ? (
    <div className="flex justify-center p-8">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  ) : (
    <AccountingHistoryTable
      rows={transactions}
      emptyLabel={t("NoEquityMovements" as any)}
      getLabel={(tx) => t(`EquityMovement_${tx.type}` as any)}
      getDate={(tx) => tx.occurredAt}
      getAmountMinor={(tx) => tx.amountMinor}
      getAmountPrefix={(tx) => (tx.type === "DRAW" ? "-" : "+")}
      getAmountClassName={(tx) => (tx.type === "DRAW" ? "text-rose-600 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-300")}
      factor={factor}
      scale={scale}
      formatCurrency={formatCurrency}
    />
  );

  return (
    <Dialog open={!!partner} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("PartnerHistory" as any)}</DialogTitle>
          <DialogDescription>{partner?.partnerName}</DialogDescription>
        </DialogHeader>

        {body}
      </DialogContent>
    </Dialog>
  );
}
