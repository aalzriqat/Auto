"use client";

import { useState } from "react";
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
import { format } from "date-fns";
import { Plus, History, ArrowDownToLine, ArrowUpFromLine, PieChart, Loader2 } from "lucide-react";
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

// Mirrors convex/utils/money.ts CURRENCY_SCALES — display-only formatting,
// same convention as FixedAssetsTab.tsx / ManualJournalTab.tsx.
const CURRENCY_SCALES: Record<string, number> = {
  JOD: 3, KWD: 3, BHD: 3, OMR: 3,
  USD: 2, EUR: 2, GBP: 2, SAR: 2, AED: 2, QAR: 2, EGP: 2,
  JPY: 0,
};
function scaleForCurrency(currency: string): number {
  return CURRENCY_SCALES[currency.toUpperCase()] ?? 2;
}

type MovementType = "CONTRIBUTION" | "DRAW" | "PROFIT_DISTRIBUTION";
type PaymentMethod = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";

type PartnerRow = NonNullable<
  ReturnType<typeof usePaginatedQuery<typeof api.partnerEquity.list>>["results"]
>[number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

  const { results: partners } = usePaginatedQuery(
    api.partnerEquity.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const [addOpen, setAddOpen] = useState(false);
  const [movement, setMovement] = useState<{ partner: PartnerRow; type: MovementType } | null>(null);
  const [historyPartner, setHistoryPartner] = useState<PartnerRow | null>(null);

  if (!partners) {
    return <div className="p-8 text-center text-slate-500">{t("LoadingEquity" as any)}</div>;
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

      <div className="rounded-md border border-slate-200 overflow-x-auto">
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
              <TableRow>
                <TableCell colSpan={4} className="text-center text-slate-500 py-8">
                  {t("NoEquityFound" as any)}
                </TableCell>
              </TableRow>
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
      </div>

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
}) {
  const { t } = useLanguage();
  const addPartner = useMutation(api.partnerEquity.add);

  const [name, setName] = useState("");
  const [openingContribution, setOpeningContribution] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setOpeningContribution("0");
    setPaymentMethod("CASH");
    setNotes("");
  }

  async function submit() {
    if (!name.trim()) {
      toast.error(t("PartnerName" as any));
      return;
    }
    const openingMinor = Math.round(Number(openingContribution || "0") * factor);
    if (!Number.isFinite(openingMinor) || openingMinor < 0) {
      toast.error(t("OpeningContributionLabel" as any));
      return;
    }
    setSubmitting(true);
    try {
      await addPartner({
        orgId,
        partnerName: name.trim(),
        notes: notes.trim() || undefined,
        openingContributionMinor: openingMinor > 0 ? openingMinor : undefined,
        paymentMethod: openingMinor > 0 ? paymentMethod : undefined,
      });
      toast.success(t("PartnerAdded" as any));
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("AddPartner" as any)}</DialogTitle>
          <DialogDescription>{t("AddPartnerDesc" as any)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("PartnerName" as any)}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("OpeningContributionLabel" as any)}</Label>
              <Input type="number" min={0} step={1 / factor} value={openingContribution} onChange={(e) => setOpeningContribution(e.target.value)} />
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
            {t("AddPartner" as any)}
          </Button>
        </DialogFooter>
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
}: {
  partner: PartnerRow;
  type: MovementType;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: (amount: number, fractionDigits?: number) => string;
}) {
  const { t } = useLanguage();
  const recordMovement = useMutation(api.partnerEquity.recordEquityMovement);
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const meta = MOVEMENT_META[type];

  async function submit() {
    const amountMinor = Math.round(Number(amount) * factor);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      toast.error(t("AmountLabel" as any));
      return;
    }
    setSubmitting(true);
    try {
      await recordMovement({
        orgId,
        partnerId: partner._id,
        type,
        amountMinor,
        paymentMethod: meta.needsPayment ? paymentMethod : undefined,
        notes: notes.trim() || undefined,
      });
      toast.success(t("EquityMovementRecorded" as any));
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(meta.titleKey as any)}</DialogTitle>
          <DialogDescription>{partner.partnerName} — {t(meta.descKey as any)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            {t("CurrentBalance" as any)}: <strong>{formatCurrency(partner.balanceMinor / factor, scale)}</strong>
          </p>

          <div className="space-y-1.5">
            <Label>{t("AmountLabel" as any)}</Label>
            <Input type="number" min={0} step={1 / factor} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>

          {meta.needsPayment && (
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
          )}

          <div className="space-y-1.5">
            <Label>{t("NotesLabel" as any)}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting} className="gap-2">
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t(meta.titleKey as any)}
          </Button>
        </DialogFooter>
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
}: {
  partner: PartnerRow | null;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: (amount: number, fractionDigits?: number) => string;
}) {
  const { t } = useLanguage();
  const transactions = useQuery(
    api.partnerEquity.listTransactions,
    partner ? { orgId, partnerId: partner._id } : "skip"
  );

  return (
    <Dialog open={!!partner} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("PartnerHistory" as any)}</DialogTitle>
          <DialogDescription>{partner?.partnerName}</DialogDescription>
        </DialogHeader>

        {transactions === undefined ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : transactions.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">{t("NoEquityMovements" as any)}</p>
        ) : (
          <Table>
            <TableBody>
              {transactions.map((tx) => (
                <TableRow key={tx._id}>
                  <TableCell className="text-sm">{t(`EquityMovement_${tx.type}` as any)}</TableCell>
                  <TableCell className="text-sm text-slate-500">{format(new Date(tx.occurredAt), "MMM d, yyyy")}</TableCell>
                  <TableCell className={`text-sm text-right font-medium ${tx.type === "DRAW" ? "text-rose-600" : "text-emerald-700"}`}>
                    {tx.type === "DRAW" ? "-" : "+"}{formatCurrency(tx.amountMinor / factor, scale)}
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
