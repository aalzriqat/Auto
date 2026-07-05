"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { usePaginatedQuery, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
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

const MOVEMENT_META: Record<MovementType, { titleKey: string; descKey: string; needsPayment: boolean }> = {
  CONTRIBUTION: { titleKey: "RecordContribution", descKey: "RecordContributionDesc", needsPayment: true },
  DRAW: { titleKey: "RecordDraw", descKey: "RecordDrawDesc", needsPayment: true },
  PROFIT_DISTRIBUTION: { titleKey: "RecordDistribution", descKey: "RecordDistributionDesc", needsPayment: false },
};

export function PartnerEquityTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
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

  if (partnersStatus === "LoadingFirstPage") {
    return <LoadingAccountingState label={t("LoadingEquity" as any)} />;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="mb-2 flex justify-between items-center gap-4 flex-wrap">
        <h2 className="text-lg font-semibold text-slate-900">{t("PartnerEquity" as any)}</h2>
        {canManage && (
          <Button size="sm" className="gap-2" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4" />
            {t("AddPartner" as any)}
          </Button>
        )}
      </div>

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-slate-50">
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
                      <span className="font-semibold text-slate-900">
                        {formatCurrency(partner.balanceMinor / factor, scale)}
                      </span>
                      {hasLegacyBase && (
                        <Badge variant="outline" className="ms-2 text-slate-500" title={t("LegacyBalanceNotice" as any)}>
                          {t("AssetStatusLegacy" as any)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-slate-500">{partner.notes || "-"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("PartnerHistory" as any)}
                          onClick={() => setHistoryPartner(partner)}
                        >
                          <History className="w-4 h-4 text-slate-500" />
                        </Button>
                        {canManage && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("RecordContribution" as any)}
                              onClick={() => setMovement({ partner, type: "CONTRIBUTION" })}
                            >
                              <ArrowDownToLine className="w-4 h-4 text-emerald-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("RecordDraw" as any)}
                              onClick={() => setMovement({ partner, type: "DRAW" })}
                            >
                              <ArrowUpFromLine className="w-4 h-4 text-rose-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("RecordDistribution" as any)}
                              onClick={() => setMovement({ partner, type: "PROFIT_DISTRIBUTION" })}
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
        <AddPartnerDialog open={addOpen} onOpenChange={setAddOpen} orgId={activeOrgId} factor={factor} />
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
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
}>) {
  const { t } = useLanguage();
  const addPartner = useMutation(api.partnerEquity.add);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const form = useForm<AddPartnerFormValues>({
    resolver: zodResolver(addPartnerSchema),
    defaultValues: { name: "", openingContribution: 0, paymentMethod: "CASH", notes: "" },
  });

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) form.reset();
  }

  async function onSubmit(values: AddPartnerFormValues) {
    const openingMinor = Math.round(values.openingContribution * factor);
    await submitWithFeedback(async () => {
      await addPartner({
        orgId,
        partnerName: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        openingContributionMinor: openingMinor > 0 ? openingMinor : undefined,
        paymentMethod: openingMinor > 0 ? values.paymentMethod : undefined,
      });
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
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                      <PaymentMethodSelect t={t as any} value={field.value} onValueChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

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

function MovementDialog({
  partner,
  type,
  onOpenChange,
  orgId,
  factor,
  scale,
  formatCurrency,
}: Readonly<{
  partner: PartnerRow;
  type: MovementType;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
}>) {
  const { t } = useLanguage();
  const recordMovement = useMutation(api.partnerEquity.recordEquityMovement);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const meta = MOVEMENT_META[type];

  const form = useForm<MovementFormValues>({
    resolver: zodResolver(movementSchema),
    defaultValues: { amount: 0, paymentMethod: "CASH", notes: "" },
  });

  async function onSubmit(values: MovementFormValues) {
    await submitWithFeedback(async () => {
      await recordMovement({
        orgId,
        partnerId: partner._id,
        type,
        amountMinor: Math.round(values.amount * factor),
        paymentMethod: meta.needsPayment ? values.paymentMethod : undefined,
        notes: values.notes?.trim() || undefined,
      });
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
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <AmountSummary
              label={t("CurrentBalance" as any)}
              value={formatCurrency(partner.balanceMinor / factor, scale)}
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
                      <PaymentMethodSelect t={t as any} value={field.value} onValueChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
      getAmountClassName={(tx) => (tx.type === "DRAW" ? "text-rose-600" : "text-emerald-700")}
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
