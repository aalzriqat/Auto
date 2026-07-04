"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { ExternalLink, Plus } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { scaleForCurrency } from "../AccountingTabShared";

type ReceivableRow = Doc<"receivables"> & {
  customerName: string;
  vehicleLabel?: string;
};

type PaymentIntentRow = Doc<"paymentIntents"> & {
  customerName: string | null;
};

function intentStatusClass(status: PaymentIntentRow["status"]) {
  if (status === "SETTLED") return "text-emerald-700";
  if (status === "FAILED" || status === "EXPIRED") return "text-rose-700";
  return "text-amber-700";
}

export function PaymentLinksPanel() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const formatCurrency = useCurrencyFormatter();
  const [createOpen, setCreateOpen] = useState(false);
  const [settleIntent, setSettleIntent] = useState<PaymentIntentRow | null>(null);

  const { results: paymentLinks, status: paymentLinkLoadStatus, loadMore: loadMorePaymentLinks } = usePaginatedQuery(
    api.paymentIntents.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 75 }
  );

  if (!activeOrgId) return null;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="me-2 h-4 w-4" />
          {t("NewPaymentLink" as any)}
        </Button>
      </div>
      <div className="rounded-md border border-slate-200 overflow-x-auto">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("Customer" as any)}</TableHead>
              <TableHead>{t("PaymentProvider" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead>{t("Reference" as any)}</TableHead>
              <TableHead className="text-right">{t("Amount" as any)}</TableHead>
              <TableHead className="text-right">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!paymentLinks ? (
              <PaymentLinkEmptyRow label={t("LoadingPaymentLinks" as any)} />
            ) : paymentLinks.length === 0 ? (
              <PaymentLinkEmptyRow label={t("NoPaymentLinksFound" as any)} />
            ) : (
              paymentLinks.map((intent: PaymentIntentRow) => (
                <TableRow key={intent._id}>
                  <TableCell>{intent.customerName ?? "-"}</TableCell>
                  <TableCell className="uppercase">{intent.provider}</TableCell>
                  <TableCell className={intentStatusClass(intent.status)}>{intent.status}</TableCell>
                  <TableCell className="text-slate-500">{intent.externalId ?? "-"}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatCurrency(intent.amountMinor / Math.pow(10, scaleForCurrency(intent.currency)))}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {intent.checkoutUrl && (
                        <Button size="sm" variant="outline" asChild>
                          <a href={intent.checkoutUrl} target="_blank" rel="noreferrer">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </Button>
                      )}
                      <Button size="sm" variant="outline" disabled={intent.status !== "PENDING"} onClick={() => setSettleIntent(intent)}>
                        {t("MarkSettled" as any)}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {paymentLinkLoadStatus === "CanLoadMore" && (
        <Button variant="outline" onClick={() => loadMorePaymentLinks(75)}>{t("LoadMore" as any)}</Button>
      )}
      <CreatePaymentLinkDialog open={createOpen} onOpenChange={setCreateOpen} />
      <SettlePaymentLinkDialog intent={settleIntent} onOpenChange={(open) => !open && setSettleIntent(null)} />
    </div>
  );
}

function PaymentLinkEmptyRow({ label }: Readonly<{ label: string }>) {
  return (
    <TableRow>
      <TableCell colSpan={6} className="text-center text-slate-500 py-8">
        {label}
      </TableCell>
    </TableRow>
  );
}

function CreatePaymentLinkDialog({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { code: currencyCode } = useCurrency();
  const scale = scaleForCurrency(currencyCode);
  const factor = Math.pow(10, scale);
  const createPaymentLink = useMutation(api.paymentIntents.create);
  const idempotencyKeyRef = useRef<string | null>(null);
  const [receivableId, setReceivableId] = useState("");
  const [amount, setAmount] = useState("");
  const [provider, setProvider] = useState("tap");
  const [externalId, setExternalId] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [providerAccountId, setProviderAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { results: receivables } = usePaginatedQuery(
    api.collections.listReceivables,
    activeOrgId && open ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const eligibleReceivables = useMemo(
    () => (receivables ?? []).filter((row: ReceivableRow) => row.outstandingAmount > 0 && row.canonicalReceivableDocumentId),
    [receivables]
  );
  const selectedReceivable = eligibleReceivables.find((row) => row._id === receivableId);

  useEffect(() => {
    if (selectedReceivable) setAmount(String(selectedReceivable.outstandingAmount));
  }, [selectedReceivable]);

  function reset() {
    idempotencyKeyRef.current = null;
    setReceivableId("");
    setAmount("");
    setProvider("tap");
    setExternalId("");
    setCheckoutUrl("");
    setProviderAccountId("");
  }

  async function submit() {
    if (!activeOrgId || !selectedReceivable) return;
    const amountMinor = Math.round(Number(amount) * factor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      toast.error(t("AmountDue" as any));
      return;
    }
    setSubmitting(true);
    try {
      idempotencyKeyRef.current ??= `payment-link:${crypto.randomUUID()}`;
      await createPaymentLink({
        orgId: activeOrgId,
        customerId: selectedReceivable.customerId,
        receivableId: selectedReceivable._id,
        receivableDocumentId: selectedReceivable.canonicalReceivableDocumentId as Id<"receivableDocuments">,
        amountMinor,
        currency: currencyCode,
        provider,
        externalId: externalId.trim() || undefined,
        checkoutUrl: checkoutUrl.trim() || undefined,
        providerAccountId: providerAccountId.trim() || undefined,
        idempotencyKey: idempotencyKeyRef.current,
      });
      toast.success(t("PaymentLinkCreated" as any));
      onOpenChange(false);
      reset();
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) reset(); onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("NewPaymentLink" as any)}</DialogTitle>
          <DialogDescription>{t("PaymentLinksDesc" as any)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <SearchableSelect
            value={receivableId}
            onValueChange={setReceivableId}
            options={eligibleReceivables.map((row) => ({
              value: row._id,
              label: `${row.customerName} - ${row.title}`,
              subLabel: String(row.outstandingAmount),
            }))}
            placeholder={t("Receivables" as any)}
            searchPlaceholder={t("SearchCustomersPlaceholder" as any)}
          />
          <Input type="number" min="0" step={1 / factor} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("Amount" as any)} />
          <Input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder={t("PaymentProvider" as any)} />
          <Input value={externalId} onChange={(event) => setExternalId(event.target.value)} placeholder={t("ProviderExternalId" as any)} />
          <Input value={checkoutUrl} onChange={(event) => setCheckoutUrl(event.target.value)} placeholder={t("CheckoutUrlOptional" as any)} />
          <Input value={providerAccountId} onChange={(event) => setProviderAccountId(event.target.value)} placeholder={t("ProviderAccountIdOptional" as any)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting || !selectedReceivable || !amount || !provider || (Boolean(checkoutUrl.trim()) && !externalId.trim())}>
            {submitting ? t("Saving" as any) : t("Create" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettlePaymentLinkDialog({ intent, onOpenChange }: Readonly<{ intent: PaymentIntentRow | null; onOpenChange: (open: boolean) => void }>) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const settlePaymentLink = useMutation(api.paymentIntents.markSettled);
  const idempotencyKeyRef = useRef<string | null>(null);
  const [externalId, setExternalId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setExternalId(intent?.externalId ?? "");
  }, [intent]);

  async function submit() {
    if (!activeOrgId || !intent) return;
    setSubmitting(true);
    try {
      idempotencyKeyRef.current ??= `settle-payment-link:${crypto.randomUUID()}`;
      await settlePaymentLink({
        orgId: activeOrgId,
        intentId: intent._id,
        externalId: externalId.trim() || undefined,
        idempotencyKey: idempotencyKeyRef.current,
      });
      idempotencyKeyRef.current = null;
      toast.success(t("PaymentLinkSettled" as any));
      onOpenChange(false);
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={intent !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("SettlePaymentLink" as any)}</DialogTitle>
          <DialogDescription>{intent?.customerName ?? "-"}</DialogDescription>
        </DialogHeader>
        <Input value={externalId} onChange={(event) => setExternalId(event.target.value)} placeholder={t("ExternalSettlementId" as any)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? t("Saving" as any) : t("MarkSettled" as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
