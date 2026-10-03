"use client";

import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ExternalLink, Plus } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { interpolate } from "@/lib/i18n/interpolate";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { busyCloseGuard } from "@/components/ui/busyCloseGuard";
import {
  AccountingEmptyRow,
  AccountingTableFrame,
  DialogFooterActions,
  LoadingAccountingState,
  scaleForCurrency,
  supportedCurrencyScale,
  useAccountingSubmit,
} from "../AccountingTabShared";

type ReceivableRow = Doc<"receivables"> & {
  customerName: string;
  vehicleLabel?: string;
};

type PaymentIntentRow = Doc<"paymentIntents"> & {
  customerName: string | null;
};

// The columns `listUnmatchedProviderFunds` returns: only what the panel shows.
type HeldPaymentRow = Pick<
  Doc<"unmatchedProviderFunds">,
  | "_id"
  | "amountMinor"
  | "currency"
  | "provider"
  | "externalId"
  | "reason"
  | "intentStatusAtReceipt"
  | "deliveryCount"
  | "amountConflict"
  | "reviewStatus"
  | "lastReceivedAt"
  | "firstReceivedAt"
  | "resolvedAt"
  | "resolutionNote"
>;

function intentStatusClass(status: PaymentIntentRow["status"]) {
  if (status === "SETTLED") return "text-emerald-700 dark:text-emerald-300";
  if (status === "FAILED" || status === "EXPIRED") return "text-rose-700 dark:text-rose-300";
  return "text-amber-700 dark:text-amber-300";
}

// SCRUM-571 D-14: amounts render in the record's own currency and scale; an
// unknown code (scaleForCurrency throws) falls back to the raw minor units.
function useIntentAmount() {
  const { t } = useLanguage();
  const formatInCurrency = useCurrencyFormatterInCurrency();
  return ({ amountMinor, currency }: Readonly<{ amountMinor: number; currency: string }>) => {
    const scale = supportedCurrencyScale(currency);
    if (scale === null) {
      return interpolate(t("HeldPaymentsRawMinor"), { amount: amountMinor, currency });
    }
    return formatInCurrency(amountMinor / Math.pow(10, scale), currency, scale);
  };
}

export function PaymentLinksPanel() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const intentAmount = useIntentAmount();
  const [createOpen, setCreateOpen] = useState(false);
  const [settleIntent, setSettleIntent] = useState<PaymentIntentRow | null>(null);
  const [expireIntent, setExpireIntent] = useState<PaymentIntentRow | null>(null);

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
      <div className="rounded-md border border-border overflow-x-auto">
        <Table>
          <TableHeader className="bg-muted/50">
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
                  <TableCell className="text-muted-foreground">{intent.externalId ?? "-"}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {intentAmount(intent)}
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
                      <Button size="sm" variant="outline" disabled={intent.status !== "PENDING"} onClick={() => setExpireIntent(intent)}>
                        {t("ExpirePaymentLink" as any)}
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
      <ExpirePaymentLinkDialog intent={expireIntent} onOpenChange={(open) => !open && setExpireIntent(null)} />
      <HeldPaymentsSection orgId={activeOrgId} />
    </div>
  );
}

// Convex's useQuery throws a failed query during render. The held-payments
// section must degrade to its own error state, not take the payment links
// table (and the whole tab) down with it.
class HeldPaymentsErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// `orgId` is the only prop and is stable, so the section re-renders only when
// its own state (the row being resolved) changes.
const HeldPaymentsSection = memo(function HeldPaymentsSection({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const { t } = useLanguage();
  const [resolving, setResolving] = useState<HeldPaymentRow | null>(null);

  return (
    <section className="space-y-2 pt-2" aria-labelledby="held-payments-title">
      <div>
        <h3 id="held-payments-title" className="text-sm font-semibold">
          {t("HeldPaymentsTitle" as any)}
        </h3>
        <p className="text-sm text-muted-foreground">{t("HeldPaymentsDesc" as any)}</p>
      </div>
      {/* Only the query and its table sit inside the boundary: a render error
          in the Resolve dialog must not be reported as "could not load". */}
      <HeldPaymentsErrorBoundary
        fallback={
          <div role="alert" className="rounded-md border border-border px-4 py-6 text-center text-sm text-rose-700 dark:text-rose-300">
            {t("HeldPaymentsError" as any)}
          </div>
        }
      >
        <HeldPaymentsTable orgId={orgId} onResolve={setResolving} />
      </HeldPaymentsErrorBoundary>
      <ResolveHeldPaymentDialog row={resolving} onOpenChange={(open) => !open && setResolving(null)} />
    </section>
  );
});

function HeldPaymentsTable({ orgId, onResolve }: Readonly<{ orgId: Id<"organizations">; onResolve: (row: HeldPaymentRow) => void }>) {
  const { t, locale } = useLanguage();
  const heldAmount = useIntentAmount();
  const received = useMemo(
    () => new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en-US", { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const held = useQuery(api.paymentIntents.listUnmatchedProviderFunds, { orgId });

  if (held === undefined) return <LoadingAccountingState label={t("HeldPaymentsLoading" as any)} />;

  return (
    <AccountingTableFrame>
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead>{t("PaymentProvider" as any)}</TableHead>
            <TableHead>{t("Reference" as any)}</TableHead>
            <TableHead>{t("Status" as any)}</TableHead>
            <TableHead>{t("HeldPaymentsReceived" as any)}</TableHead>
            <TableHead>{t("HeldPaymentsDeliveries" as any)}</TableHead>
            <TableHead className="text-end">{t("Amount" as any)}</TableHead>
            <TableHead className="text-end">{t("Actions" as any)}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {held.length === 0 ? (
            <AccountingEmptyRow colSpan={7} label={t("HeldPaymentsEmpty" as any)} />
          ) : (
            held.map((row: HeldPaymentRow) => (
              <TableRow key={row._id}>
                <TableCell className="uppercase">{row.provider}</TableCell>
                <TableCell className="text-muted-foreground">{row.externalId}</TableCell>
                <TableCell>
                  <div>{t(`HeldPaymentsReason_${row.reason}` as any)}</div>
                  {row.amountConflict && (
                    <span className="mt-1 inline-block rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                      {t("HeldPaymentsConflict" as any)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{received.format(row.lastReceivedAt)}</TableCell>
                <TableCell>{row.deliveryCount}</TableCell>
                <TableCell className="text-end font-semibold">{heldAmount(row)}</TableCell>
                <TableCell className="text-end">
                  {row.reviewStatus === "OPEN" ? (
                    <Button size="sm" variant="outline" onClick={() => onResolve(row)}>
                      {t("HeldPaymentsResolve" as any)}
                    </Button>
                  ) : (
                    <span className="text-sm text-emerald-700 dark:text-emerald-300">{t("HeldPaymentsResolved" as any)}</span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </AccountingTableFrame>
  );
}

function ResolveHeldPaymentDialog({ row, onOpenChange }: Readonly<{ row: HeldPaymentRow | null; onOpenChange: (open: boolean) => void }>) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const resolveHeldPayment = useMutation(api.paymentIntents.resolveUnmatchedProviderFunds);
  const [note, setNote] = useState("");
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  // Every way out clears the note, so the next row never opens on a stale one.
  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setNote("");
    onOpenChange(nextOpen);
  }
  const guard = busyCloseGuard(submitting, handleOpenChange);

  async function submit() {
    if (!activeOrgId || !row) return;
    await submitWithFeedback(async () => {
      // The server trims and validates; `note.trim()` only gates the button.
      await resolveHeldPayment({ orgId: activeOrgId, id: row._id, note });
      toast.success(t("HeldPaymentsResolvedToast" as any));
      handleOpenChange(false);
    });
  }

  return (
    <Dialog open={row !== null} onOpenChange={guard.onOpenChange}>
      <DialogContent {...guard.content}>
        <DialogHeader>
          <DialogTitle>{t("HeldPaymentsResolveTitle" as any)}</DialogTitle>
          <DialogDescription>{t("HeldPaymentsResolveDescription" as any)}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-label={t("HeldPaymentsNoteLabel" as any)}
          placeholder={t("HeldPaymentsNoteLabel" as any)}
          maxLength={1000}
        />
        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={t("HeldPaymentsResolve" as any)}
            onCancel={() => handleOpenChange(false)}
            onConfirm={submit}
            submitting={submitting}
            disabled={!note.trim()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentLinkEmptyRow({ label }: Readonly<{ label: string }>) {
  return (
    <TableRow>
      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
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
  const { submitting, submitWithFeedback } = useAccountingSubmit();

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

  // A closed dialog never carries its attempt's key into the next one. In an
  // effect, not in `reset`, because `busyCloseGuard` takes the close handler
  // during render and a ref write there reads as a render-time ref access.
  useEffect(() => {
    if (!open) idempotencyKeyRef.current = null;
  }, [open]);

  function reset() {
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
    await submitWithFeedback(async () => {
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
      handleOpenChange(false);
    });
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  }
  const guard = busyCloseGuard(submitting, handleOpenChange);

  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="max-w-xl" {...guard.content}>
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
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={submitting ? t("Saving" as any) : t("Create" as any)}
            onCancel={() => handleOpenChange(false)}
            onConfirm={submit}
            submitting={submitting}
            disabled={!selectedReceivable || !amount || !provider || (Boolean(checkoutUrl.trim()) && !externalId.trim())}
          />
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
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  useEffect(() => {
    setExternalId(intent?.externalId ?? "");
    idempotencyKeyRef.current = null;
  }, [intent]);

  // The attempt key is cleared by the effect above whenever `intent` changes,
  // and closing the dialog clears `intent`, so no close route needs to touch it.
  const guard = busyCloseGuard(submitting, onOpenChange);

  async function submit() {
    if (!activeOrgId || !intent) return;
    await submitWithFeedback(async () => {
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
    });
  }

  return (
    <Dialog open={intent !== null} onOpenChange={guard.onOpenChange}>
      <DialogContent {...guard.content}>
        <DialogHeader>
          <DialogTitle>{t("SettlePaymentLink" as any)}</DialogTitle>
          <DialogDescription>{intent?.customerName ?? "-"}</DialogDescription>
        </DialogHeader>
        <Input value={externalId} onChange={(event) => setExternalId(event.target.value)} placeholder={t("ExternalSettlementId" as any)} />
        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={submitting ? t("Saving" as any) : t("MarkSettled" as any)}
            onCancel={() => onOpenChange(false)}
            onConfirm={submit}
            submitting={submitting}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExpirePaymentLinkDialog({ intent, onOpenChange }: Readonly<{ intent: PaymentIntentRow | null; onOpenChange: (open: boolean) => void }>) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const intentAmount = useIntentAmount();
  const expirePaymentLink = useMutation(api.paymentIntents.expire);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  async function submit() {
    if (!activeOrgId || !intent) return;
    await submitWithFeedback(async () => {
      await expirePaymentLink({ orgId: activeOrgId, intentId: intent._id });
      toast.success(t("PaymentLinkExpired" as any));
      onOpenChange(false);
    });
  }

  const amount = intent ? intentAmount(intent) : "";
  const guard = busyCloseGuard(submitting, onOpenChange);

  return (
    <Dialog open={intent !== null} onOpenChange={guard.onOpenChange}>
      <DialogContent {...guard.content}>
        <DialogHeader>
          <DialogTitle>{t("ExpirePaymentLinkTitle" as any)}</DialogTitle>
          <DialogDescription>
            {interpolate(t("ExpirePaymentLinkDescription" as any), { customer: intent?.customerName ?? "-", amount })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={t("ExpirePaymentLink" as any)}
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