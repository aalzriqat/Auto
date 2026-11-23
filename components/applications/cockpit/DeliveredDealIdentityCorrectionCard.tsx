"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { formatLocalized } from "@/lib/dateLocale";
import { getCodedErrorMessage } from "@/lib/errors";

type Kind = "BUYER" | "VEHICLE";
type LenderReturn = NonNullable<FunctionArgs<typeof api.financeIdentityBeforeHandover.applyCorrection>["lenderReturn"]>;
type OriginalReceipt = Pick<LenderReturn, "paymentId" | "amountMinor" | "receiptStamp"> & { reference: string; paidAt: number };
type Edit =
  | { mode: "request"; quoteId: Id<"quotes">; handoverAt: number; economicsStamp: string }
  | { mode: "beforeHandover"; quoteId: Id<"quotes">; updatedAt: number; economicsStamp: string; requiresLenderConfirmation: boolean; originalReceipt?: OriginalReceipt }
  | { mode: "approve" | "withdraw"; correctionId: Id<"deliveredDealIdentityCorrections"> };
type Props = Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  money?: (minor: number) => string;
  t: (key: string) => string;
}>;

export function DeliveredDealIdentityCorrectionCard({ orgId, applicationId, money, t }: Props) {
  const { locale, isRtl } = useLanguage();
  const field = useId();
  const [kind, setKind] = useState<Kind>("BUYER");
  const [cursors, setCursors] = useState<string[]>([]);
  const [quoteId, setQuoteId] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [text, setText] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const drafts = useRef({ request: { text: "", version: 0 }, approval: { text: "", version: 0 } });
  const command = useCommandIdentity();
  const info = useQuery(api.deliveredDealIdentityCorrections.detail, { orgId, applicationId, kind, cursor: cursors.at(-1) });
  const request = useMutation(api.deliveredDealIdentityCorrections.request);
  const applyBeforeHandover = useMutation(api.financeIdentityBeforeHandover.applyCorrection);
  const approve = useMutation(api.deliveredDealIdentityCorrections.approve);
  const withdraw = useMutation(api.deliveredDealIdentityCorrections.withdraw);
  if (!info) return null;
  const lenderReturn = info.state === "BLOCKED" && money ? info.lenderReturn : undefined;
  const available = info.state === "AVAILABLE" || info.state === "AVAILABLE_BEFORE_HANDOVER" ? info
    : lenderReturn ? { ...lenderReturn, state: "AVAILABLE_BEFORE_HANDOVER" as const } : null;
  const pending = info.state === "PENDING" ? info : null;
  const selected = available?.options.find((option) => option.quoteId === quoteId);
  const requestedStillCurrent = edit?.mode === "request" && available?.state === "AVAILABLE" &&
    selected?.quoteId === edit.quoteId && available?.handoverAt === edit.handoverAt &&
    available?.economicsStamp === edit.economicsStamp;
  const beforeHandoverStillCurrent = edit?.mode === "beforeHandover" && available?.state === "AVAILABLE_BEFORE_HANDOVER" &&
    selected?.quoteId === edit.quoteId && available.updatedAt === edit.updatedAt &&
    available.economicsStamp === edit.economicsStamp &&
    lenderReturn?.originalReceipt.receiptStamp === edit.originalReceipt?.receiptStamp &&
    (available.requiresLenderConfirmation === true) === edit.requiresLenderConfirmation;
  const pendingStillCurrent = (edit?.mode === "approve" || edit?.mode === "withdraw") && edit.correctionId === pending?.correctionId;
  const allowed = edit?.mode === "request" ? requestedStillCurrent
    : edit?.mode === "beforeHandover" ? beforeHandoverStillCurrent
      : pendingStillCurrent && (edit?.mode === "withdraw" || pending?.canApprove);

  function open(next: Edit | null) {
    setText("");
    setReturnDate("");
    setError("");
    setEdit(next);
  }

  function draftVersion(mode: "request" | "approval", value: string) {
    const draft = drafts.current[mode];
    if (draft.text !== value) {
      draft.text = value;
      draft.version += 1;
    }
    return draft.version;
  }

  async function sendRequest({ quoteId: replacementQuoteId, handoverAt, economicsStamp, reason }: {
    quoteId: Id<"quotes">; handoverAt: number; economicsStamp: string; reason: string;
  }) {
    const version = draftVersion("request", reason);
    const intent = `identity-correction:${version}:${applicationId}:${handoverAt}:${economicsStamp}:${replacementQuoteId}`;
    const idempotencyKey = command.for(intent);
    if (typeof idempotencyKey !== "string") return false;
    await request({ orgId, applicationId, replacementQuoteId, expectedHandoverAt: handoverAt,
      expectedEconomicsStamp: economicsStamp, idempotencyKey, reason });
    command.retire(intent);
    return true;
  }

  async function sendApproval({ correctionId, returnedAt, returnReference }: {
    correctionId: Id<"deliveredDealIdentityCorrections">; returnedAt: number; returnReference: string;
  }) {
    const version = draftVersion("approval", returnReference);
    const intent = `approve-identity-correction:${version}:${correctionId}:${returnedAt}`;
    const idempotencyKey = command.for(intent);
    if (typeof idempotencyKey !== "string") return false;
    await approve({ orgId, correctionId, returnedAt, returnReference, idempotencyKey });
    command.retire(intent);
    return true;
  }

  async function sendBeforeHandover({
    quoteId: replacementQuoteId, updatedAt: expectedUpdatedAt, economicsStamp: expectedEconomicsStamp,
    reason, lenderConfirmationReference, confirmedLenderReturn,
  }: Extract<Edit, { mode: "beforeHandover" }> & {
    reason: string; lenderConfirmationReference?: string; confirmedLenderReturn?: LenderReturn;
  }) {
    const version = draftVersion("request", JSON.stringify([reason, lenderConfirmationReference, confirmedLenderReturn]));
    const intent = `identity-before-handover:${version}:${applicationId}:${expectedUpdatedAt}:${expectedEconomicsStamp}:${replacementQuoteId}`;
    const idempotencyKey = command.for(intent);
    if (typeof idempotencyKey !== "string") return false;
    await applyBeforeHandover({
      orgId, applicationId, replacementQuoteId, expectedEconomicsStamp, expectedUpdatedAt, reason, idempotencyKey,
      lenderConfirmationReference,
      ...(confirmedLenderReturn === undefined ? {} : { lenderReturn: confirmedLenderReturn }),
    });
    command.retire(intent);
    return true;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || !allowed || busy) return;
    const value = text.trim();
    const fields = new FormData(event.currentTarget);
    const enteredReference = edit.mode === "beforeHandover" && edit.requiresLenderConfirmation
      ? fields.get("lenderConfirmationReference")
      : null;
    const reference = typeof enteredReference === "string" ? enteredReference.trim() : undefined;
    setBusy(true);
    setError("");
    try {
      if (edit.mode === "withdraw") {
        await withdraw({ orgId, correctionId: edit.correctionId });
        drafts.current.request.version += 1;
      } else if (edit.mode === "request") {
        if (!value || !await sendRequest({ ...edit, reason: value })) throw new Error("Invalid correction request");
      } else if (edit.mode === "beforeHandover") {
        let confirmedLenderReturn: LenderReturn | undefined;
        if (edit.originalReceipt) {
          const refundReference = fields.get("refundReference");
          const refundedAt = Date.parse(returnDate);
          if (typeof refundReference !== "string" || !refundReference.trim() ||
              !Number.isSafeInteger(refundedAt) || fields.get("verifiedSamePayer") !== "on") {
            throw new Error("Invalid lender return evidence");
          }
          const { paymentId, amountMinor, receiptStamp } = edit.originalReceipt;
          confirmedLenderReturn = {
            paymentId, amountMinor, receiptStamp, reference: refundReference.trim(), refundedAt, verifiedSamePayer: true,
          };
        }
        if (!value || (edit.requiresLenderConfirmation && !reference) ||
            !await sendBeforeHandover({ ...edit, reason: value, lenderConfirmationReference: reference, confirmedLenderReturn })) {
          throw new Error("Invalid correction");
        }
      } else {
        const returnedAt = Date.parse(returnDate);
        if (!value || !Number.isSafeInteger(returnedAt) ||
            !await sendApproval({ correctionId: edit.correctionId, returnedAt, returnReference: value })) {
          throw new Error("Invalid return confirmation");
        }
      }
      setQuoteId("");
      open(null);
    } catch (cause) {
      setError(getCodedErrorMessage(cause, t) ??
        t(edit.mode === "beforeHandover" ? "IdentityBeforeHandoverError" : "DeliveredIdentityError"));
    } finally {
      setBusy(false);
    }
  }

  function selectKind(next: Kind) {
    setKind(next);
    setQuoteId("");
    setCursors([]);
  }

  const title = edit?.mode === "approve" ? "DeliveredIdentityApprove"
    : edit?.mode === "withdraw" ? "DeliveredIdentityWithdraw"
      : edit?.mode === "beforeHandover" ? "IdentityBeforeHandoverApply" : "DeliveredIdentityRequest";
  const help = edit?.mode === "withdraw" ? "DeliveredIdentityWithdrawHelp"
    : edit?.mode === "beforeHandover" && edit.requiresLenderConfirmation ? "IdentityBeforeHandoverLenderHelp"
      : edit?.mode === "beforeHandover" ? "IdentityBeforeHandoverHelp" : "DeliveredIdentityHelp";

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 text-start">
      <h3 className="font-medium">{t("DeliveredIdentityTitle")}</h3>
      {info.state === "BLOCKED" && !lenderReturn && (
        <p className="text-sm text-muted-foreground">{t("DeliveredIdentityBlocked")}</p>
      )}
      {lenderReturn && <p className="text-sm text-muted-foreground">{t("IdentityBeforeHandoverRefundHelp")}</p>}
      {available && <>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant={kind === "BUYER" ? "secondary" : "outline"} aria-pressed={kind === "BUYER"}
            onClick={() => selectKind("BUYER")}>{t("DeliveredIdentityBuyer")}</Button>
          <Button type="button" size="sm" variant={kind === "VEHICLE" ? "secondary" : "outline"} aria-pressed={kind === "VEHICLE"}
            onClick={() => selectKind("VEHICLE")}>{t("DeliveredIdentityVehicle")}</Button>
        </div>
        {available.options.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={field}>{t("DeliveredIdentityQuote")}</Label>
            <Select dir={isRtl ? "rtl" : "ltr"} value={quoteId} onValueChange={setQuoteId}>
              <SelectTrigger id={field}><SelectValue /></SelectTrigger>
              <SelectContent>{available.options.map((option) => (
                <SelectItem key={option.quoteId} value={option.quoteId}>
                  {option.label} · {formatLocalized(option.quotedAt, "d MMM yyyy", locale)}
                </SelectItem>
              ))}</SelectContent>
            </Select>
            <Button type="button" disabled={!selected} onClick={() => {
              if (!selected) return;
              const choice = { quoteId: selected.quoteId, economicsStamp: available.economicsStamp };
              open(available.state === "AVAILABLE_BEFORE_HANDOVER"
                ? {
                    ...choice, mode: "beforeHandover", updatedAt: available.updatedAt,
                    requiresLenderConfirmation: available.requiresLenderConfirmation === true,
                    originalReceipt: lenderReturn?.originalReceipt,
                  }
                : { ...choice, mode: "request", handoverAt: available.handoverAt });
            }}>{t(available.state === "AVAILABLE_BEFORE_HANDOVER" ? "IdentityBeforeHandoverApply" : "DeliveredIdentityRequest")}</Button>
          </div>
        ) : <p className="text-sm text-muted-foreground">{t("DeliveredIdentityNoQuote")}</p>}
        {(cursors.length > 0 || available.nextCursor) && (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!cursors.length} onClick={() => {
              setQuoteId("");
              setCursors((pages) => pages.slice(0, -1));
            }}>{t("DeliveredIdentityNewerQuotes")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={!available.nextCursor} onClick={() => {
              const cursor = available.nextCursor;
              if (cursor) {
                setQuoteId("");
                setCursors((pages) => [...pages, cursor]);
              }
            }}>{t("DeliveredLenderOlderQuotes")}</Button>
          </div>
        )}
      </>}
      {pending && <>
        <p className="text-sm"><bdi>{pending.label}</bdi> · {pending.reason}</p>
        <p className="text-sm text-muted-foreground">{t("DeliveredIdentityPending")}</p>
        <div className="flex flex-wrap gap-2">
          {pending.canApprove && <Button type="button" onClick={() =>
            open({ mode: "approve", correctionId: pending.correctionId })}>{t("DeliveredIdentityApprove")}</Button>}
          {pending.canWithdraw && <Button type="button" variant="outline" onClick={() =>
            open({ mode: "withdraw", correctionId: pending.correctionId })}>{t("DeliveredIdentityWithdraw")}</Button>}
        </div>
      </>}
      {info.state === "APPROVED" && (
        <dl className="grid gap-1 text-sm">
          <dt>{t("DeliveredIdentityOriginalHandover")}</dt>
          <dd>{formatLocalized(info.handoverAt, "d MMM yyyy HH:mm", locale)}</dd>
          <dt>{t("DeliveredIdentityReturnTime")}</dt>
          <dd>{formatLocalized(info.returnedAt, "d MMM yyyy HH:mm", locale)} · <bdi>{info.returnReference}</bdi></dd>
        </dl>
      )}
      <Dialog open={edit !== null} onOpenChange={(isOpen) => { if (!isOpen && !busy) open(null); }}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle>{t(title)}</DialogTitle>
            <DialogDescription>{t(help)}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-3">
            {edit?.mode === "approve" && <div className="space-y-1">
              <Label htmlFor={`${field}-time`}>{t("DeliveredIdentityReturnTime")}</Label>
              <Input id={`${field}-time`} type="datetime-local" step="1" required value={returnDate}
                onChange={(event) => setReturnDate(event.target.value)} />
            </div>}
            {edit?.mode === "beforeHandover" && edit.requiresLenderConfirmation && <div className="space-y-1">
              <Label htmlFor={`${field}-lender`}>{t("IdentityBeforeHandoverLenderReference")}</Label>
              <Input id={`${field}-lender`} name="lenderConfirmationReference" required maxLength={160} />
            </div>}
            {edit?.mode === "beforeHandover" && edit.originalReceipt && money && <fieldset className="space-y-3">
              <legend className="text-sm font-medium">{t("IdentityBeforeHandoverRefundEvidence")}</legend>
              <p className="text-sm">
                <bdi>{edit.originalReceipt.reference}</bdi>{" · "}
                <bdi>{money(edit.originalReceipt.amountMinor)}</bdi>{" · "}
                <bdi>{formatLocalized(edit.originalReceipt.paidAt, "d MMM yyyy HH:mm", locale)}</bdi>
              </p>
              <div className="space-y-1">
                <Label htmlFor={`${field}-refund-reference`}>{t("IdentityBeforeHandoverRefundReference")}</Label>
                <Input id={`${field}-refund-reference`} name="refundReference" required maxLength={160} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${field}-refund-time`}>{t("IdentityBeforeHandoverRefundTime")}</Label>
                <Input id={`${field}-refund-time`} type="datetime-local" step="1" dir="ltr" value={returnDate}
                  onChange={(event) => setReturnDate(event.target.value)} required />
              </div>
              <Label className="flex items-start gap-2">
                <input type="checkbox" name="verifiedSamePayer" required />
                {t("IdentityBeforeHandoverRefundVerify")}
              </Label>
            </fieldset>}
            {edit?.mode !== "withdraw" && <div className="space-y-1">
              <Label htmlFor={`${field}-text`}>{t(edit?.mode === "approve" ? "DeliveredIdentityReference" : "DeliveredIdentityReason")}</Label>
              <Textarea id={`${field}-text`} value={text} required maxLength={500}
                onChange={(event) => setText(event.target.value)} />
            </div>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => open(null)} disabled={busy}>{t("Cancel")}</Button>
              <Button type="submit" disabled={busy || !allowed}>{t(title)}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
