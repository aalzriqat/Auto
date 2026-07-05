"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { usePaginatedQuery, useMutation } from "convex/react";
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
import { Plus, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  type PaymentMethod,
} from "./AccountingTabShared";
import { newClaimSchema, type NewClaimFormValues } from "./claim.schema";

type Claim = Doc<"claims">;

const STATUS_BADGE_CLASS: Record<Claim["status"], string> = {
  PENDING: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  PAID: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  REJECTED: "bg-rose-500/10 text-rose-600 border-rose-500/20",
  CANCELLED: "bg-slate-500/10 text-slate-500 border-slate-500/20",
};

export function ClaimsTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { code: currencyCode } = useCurrency();
  const formatCurrency = useCurrencyFormatter();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const scale = scaleForCurrency(currencyCode);
  const factor = Math.pow(10, scale);

  const { results: claims, status: claimsStatus } = usePaginatedQuery(
    api.claims.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const [newOpen, setNewOpen] = useState(false);
  const [settleClaim, setSettleClaim] = useState<Claim | null>(null);
  const [rejectClaim, setRejectClaim] = useState<Claim | null>(null);

  if (claimsStatus === "LoadingFirstPage") {
    return <LoadingAccountingState label={t("LoadingClaims" as any)} />;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="mb-2 flex justify-between items-center gap-4 flex-wrap">
        <h2 className="text-lg font-semibold text-slate-900">{t("Claims" as any)}</h2>
        {canManage && (
          <Button size="sm" className="gap-2" onClick={() => setNewOpen(true)}>
            <Plus className="w-4 h-4" />
            {t("NewClaim" as any)}
          </Button>
        )}
      </div>

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("Date" as any)}</TableHead>
              <TableHead>{t("FinancingEntity" as any)}</TableHead>
              <TableHead>{t("BuyerName" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-right">{t("ClaimAmount" as any)}</TableHead>
              <TableHead className="text-right">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {claims.length === 0 ? (
              <AccountingEmptyRow colSpan={6} label={t("NoClaimsFound" as any)} />
            ) : (
              claims.map((claim) => {
                const isLegacy = claim.claimAmountMinor == null;
                const amountDisplay = isLegacy
                  ? formatCurrency(claim.claimAmount ?? 0)
                  : formatCurrency(claim.claimAmountMinor! / factor, scale);
                const canAct = canManage && !isLegacy && claim.status === "PENDING";
                return (
                  <TableRow key={claim._id}>
                    <TableCell className="font-medium">
                      {format(new Date(claim.claimDate), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>{claim.financingEntity}</TableCell>
                    <TableCell>{claim.buyerName}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_BADGE_CLASS[claim.status]}>
                        {t(`ClaimStatus_${claim.status}` as any)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-semibold text-slate-900">
                      {amountDisplay}
                    </TableCell>
                    <TableCell className="text-right">
                      {canAct && (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("SettleClaim" as any)}
                            onClick={() => setSettleClaim(claim)}
                          >
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("RejectClaim" as any)}
                            onClick={() => setRejectClaim(claim)}
                          >
                            <XCircle className="w-4 h-4 text-rose-600" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>

      {activeOrgId && canManage && (
        <NewClaimDialog open={newOpen} onOpenChange={setNewOpen} orgId={activeOrgId} factor={factor} />
      )}

      {activeOrgId && settleClaim && (
        <SettleClaimDialog
          claim={settleClaim}
          onOpenChange={(open) => !open && setSettleClaim(null)}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
          formatCurrency={formatCurrency}
        />
      )}

      {activeOrgId && rejectClaim && (
        <RejectClaimDialog
          claim={rejectClaim}
          onOpenChange={(open) => !open && setRejectClaim(null)}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
          formatCurrency={formatCurrency}
        />
      )}
    </div>
  );
}

function NewClaimDialog({
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
  const addClaim = useMutation(api.claims.add);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const form = useForm<NewClaimFormValues>({
    resolver: zodResolver(newClaimSchema),
    defaultValues: {
      financingEntity: "",
      buyerName: "",
      amount: 0,
      claimDate: todayInput,
      notes: "",
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) form.reset();
  }

  async function onSubmit(values: NewClaimFormValues) {
    await submitWithFeedback(async () => {
      await addClaim({
        orgId,
        claimDate: dateInputToMs(values.claimDate),
        financingEntity: values.financingEntity.trim(),
        buyerName: values.buyerName.trim(),
        claimAmountMinor: Math.round(values.amount * factor),
        notes: values.notes?.trim() || undefined,
      });
      toast.success(t("ClaimCreated" as any));
      handleOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("NewClaim" as any)}</DialogTitle>
          <DialogDescription>{t("NewClaimDesc" as any)}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="financingEntity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("FinancingEntity" as any)}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="buyerName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("BuyerName" as any)}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("ClaimAmount" as any)}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step={1 / factor} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="claimDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("ClaimDateLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
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
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <DialogFooterActions
                cancelLabel={t("Cancel" as any)}
                confirmLabel={t("NewClaim" as any)}
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

function SettleClaimDialog({
  claim,
  onOpenChange,
  orgId,
  factor,
  scale,
  formatCurrency,
}: Readonly<{
  claim: Claim;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
}>) {
  const { t } = useLanguage();
  const settle = useMutation(api.claims.settle);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("BANK_TRANSFER");
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  async function submit() {
    await submitWithFeedback(async () => {
      await settle({ orgId, claimId: claim._id, paymentMethod });
      toast.success(t("ClaimSettledToast" as any));
      onOpenChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("SettleClaim" as any)}</DialogTitle>
          <DialogDescription>
            {claim.buyerName} ({claim.financingEntity}) — {t("SettleClaimDesc" as any)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <AmountSummary
            label={t("ClaimAmount" as any)}
            value={formatCurrency((claim.claimAmountMinor ?? 0) / factor, scale)}
          />

          <div className="space-y-1.5">
            <Label>{t("PaymentMethodLabel" as any)}</Label>
            <PaymentMethodSelect
              t={t as any}
              value={paymentMethod}
              onValueChange={setPaymentMethod}
              methods={["BANK_TRANSFER", "CASH", "CHEQUE", "CARD"]}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={t("ConfirmSettle" as any)}
            onCancel={() => onOpenChange(false)}
            onConfirm={submit}
            submitting={submitting}
            confirmClassName="bg-emerald-600 hover:bg-emerald-700 text-white"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectClaimDialog({
  claim,
  onOpenChange,
  orgId,
  factor,
  scale,
  formatCurrency,
}: Readonly<{
  claim: Claim;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
}>) {
  const { t } = useLanguage();
  const reject = useMutation(api.claims.reject);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  async function submit() {
    await submitWithFeedback(async () => {
      await reject({ orgId, claimId: claim._id });
      toast.success(t("ClaimRejectedToast" as any));
      onOpenChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RejectClaim" as any)}</DialogTitle>
          <DialogDescription>
            {claim.buyerName} ({claim.financingEntity}) — {t("RejectClaimDesc" as any)}
          </DialogDescription>
        </DialogHeader>

        <AmountSummary
          label={t("ClaimAmount" as any)}
          value={formatCurrency((claim.claimAmountMinor ?? 0) / factor, scale)}
        />

        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={t("ConfirmReject" as any)}
            onCancel={() => onOpenChange(false)}
            onConfirm={submit}
            submitting={submitting}
            confirmVariant="destructive"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
