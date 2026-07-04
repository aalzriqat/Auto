"use client";

import { useState } from "react";
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
import { Plus, CheckCircle2, XCircle, Loader2 } from "lucide-react";
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
// same convention as the other accounting tabs.
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

type Claim = Doc<"claims">;
type PaymentMethod = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

  const { results: claims } = usePaginatedQuery(
    api.claims.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const [newOpen, setNewOpen] = useState(false);
  const [settleClaim, setSettleClaim] = useState<Claim | null>(null);
  const [rejectClaim, setRejectClaim] = useState<Claim | null>(null);

  if (!claims) {
    return <div className="p-8 text-center text-slate-500">{t("LoadingClaims" as any)}</div>;
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

      <div className="rounded-md border border-slate-200 overflow-x-auto">
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
              <TableRow>
                <TableCell colSpan={6} className="text-center text-slate-500 py-8">
                  {t("NoClaimsFound" as any)}
                </TableCell>
              </TableRow>
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
      </div>

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
}) {
  const { t } = useLanguage();
  const addClaim = useMutation(api.claims.add);

  const [financingEntity, setFinancingEntity] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [amount, setAmount] = useState("");
  const [claimDate, setClaimDate] = useState(todayInput);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setFinancingEntity("");
    setBuyerName("");
    setAmount("");
    setClaimDate(todayInput);
    setNotes("");
  }

  async function submit() {
    if (!financingEntity.trim() || !buyerName.trim()) {
      toast.error(t("FinancingEntity" as any));
      return;
    }
    const amountMinor = Math.round(Number(amount) * factor);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      toast.error(t("ClaimAmount" as any));
      return;
    }
    setSubmitting(true);
    try {
      await addClaim({
        orgId,
        claimDate: dateInputToMs(claimDate),
        financingEntity: financingEntity.trim(),
        buyerName: buyerName.trim(),
        claimAmountMinor: amountMinor,
        notes: notes.trim() || undefined,
      });
      toast.success(t("ClaimCreated" as any));
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
          <DialogTitle>{t("NewClaim" as any)}</DialogTitle>
          <DialogDescription>{t("NewClaimDesc" as any)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("FinancingEntity" as any)}</Label>
              <Input value={financingEntity} onChange={(e) => setFinancingEntity(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("BuyerName" as any)}</Label>
              <Input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("ClaimAmount" as any)}</Label>
              <Input type="number" min={0} step={1 / factor} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("ClaimDateLabel" as any)}</Label>
              <Input type="date" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} />
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
            {t("NewClaim" as any)}
          </Button>
        </DialogFooter>
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
}: {
  claim: Claim;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: (amount: number, fractionDigits?: number) => string;
}) {
  const { t } = useLanguage();
  const settle = useMutation(api.claims.settle);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("BANK_TRANSFER");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      await settle({ orgId, claimId: claim._id, paymentMethod });
      toast.success(t("ClaimSettledToast" as any));
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
          <DialogTitle>{t("SettleClaim" as any)}</DialogTitle>
          <DialogDescription>
            {claim.buyerName} ({claim.financingEntity}) — {t("SettleClaimDesc" as any)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            {t("ClaimAmount" as any)}: <strong>{formatCurrency((claim.claimAmountMinor ?? 0) / factor, scale)}</strong>
          </p>

          <div className="space-y-1.5">
            <Label>{t("PaymentMethodLabel" as any)}</Label>
            <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as PaymentMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BANK_TRANSFER">{t("PaymentMethod_BANK_TRANSFER" as any)}</SelectItem>
                <SelectItem value="CASH">{t("PaymentMethod_CASH" as any)}</SelectItem>
                <SelectItem value="CHEQUE">{t("PaymentMethod_CHEQUE" as any)}</SelectItem>
                <SelectItem value="CARD">{t("PaymentMethod_CARD" as any)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button
            onClick={submit}
            disabled={submitting}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("ConfirmSettle" as any)}
          </Button>
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
}: {
  claim: Claim;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: (amount: number, fractionDigits?: number) => string;
}) {
  const { t } = useLanguage();
  const reject = useMutation(api.claims.reject);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      await reject({ orgId, claimId: claim._id });
      toast.success(t("ClaimRejectedToast" as any));
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
          <DialogTitle>{t("RejectClaim" as any)}</DialogTitle>
          <DialogDescription>
            {claim.buyerName} ({claim.financingEntity}) — {t("RejectClaimDesc" as any)}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-slate-500">
          {t("ClaimAmount" as any)}: <strong>{formatCurrency((claim.claimAmountMinor ?? 0) / factor, scale)}</strong>
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button
            onClick={submit}
            disabled={submitting}
            variant="destructive"
            className="gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("ConfirmReject" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
