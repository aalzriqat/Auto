"use client";

import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
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
type Edit =
  | { mode: "request"; quoteId: Id<"quotes">; handoverAt: number; economicsStamp: string }
  | { mode: "approve" | "withdraw"; correctionId: Id<"deliveredDealIdentityCorrections"> };
type Props = Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  t: (key: string) => string;
}>;

export function DeliveredDealIdentityCorrectionCard({ orgId, applicationId, t }: Props) {
  const { locale } = useLanguage();
  const field = useId();
  const [kind, setKind] = useState<Kind>("BUYER");
  const [cursors, setCursors] = useState<string[]>([]);
  const [quoteId, setQuoteId] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [text, setText] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const command = useCommandIdentity();
  const info = useQuery(api.deliveredDealIdentityCorrections.detail, { orgId, applicationId, kind, cursor: cursors.at(-1) });
  const request = useMutation(api.deliveredDealIdentityCorrections.request);
  const approve = useMutation(api.deliveredDealIdentityCorrections.approve);
  const withdraw = useMutation(api.deliveredDealIdentityCorrections.withdraw);
  if (!info) return null;
  const available = info.state === "AVAILABLE" ? info : null;
  const pending = info.state === "PENDING" ? info : null;
  const selected = available?.options.find((option) => option.quoteId === quoteId);
  const requestedStillCurrent = edit?.mode === "request" &&
    selected?.quoteId === edit.quoteId && available?.handoverAt === edit.handoverAt &&
    available?.economicsStamp === edit.economicsStamp;
  const pendingStillCurrent = edit && edit.mode !== "request" && edit.correctionId === pending?.correctionId;
  const allowed = edit?.mode === "request" ? requestedStillCurrent
    : pendingStillCurrent && (edit?.mode === "withdraw" || pending?.canApprove);

  function open(next: Edit | null) {
    setText("");
    setReturnDate("");
    setError("");
    setEdit(next);
  }

  async function sendRequest({ quoteId: replacementQuoteId, handoverAt, economicsStamp, reason }: {
    quoteId: Id<"quotes">; handoverAt: number; economicsStamp: string; reason: string;
  }) {
    const intent = `identity-correction:${applicationId}:${handoverAt}:${economicsStamp}:${replacementQuoteId}`;
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
    const intent = `approve-identity-correction:${correctionId}:${returnedAt}`;
    const idempotencyKey = command.for(intent);
    if (typeof idempotencyKey !== "string") return false;
    await approve({ orgId, correctionId, returnedAt, returnReference, idempotencyKey });
    command.retire(intent);
    return true;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || !allowed || busy) return;
    const value = text.trim();
    setBusy(true);
    setError("");
    try {
      if (edit.mode === "withdraw") {
        await withdraw({ orgId, correctionId: edit.correctionId });
      } else if (edit.mode === "request") {
        if (!value || !await sendRequest({ ...edit, reason: value })) throw new Error("Invalid correction request");
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
      setError(getCodedErrorMessage(cause, t) ?? t("DeliveredIdentityError"));
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
    : edit?.mode === "withdraw" ? "DeliveredIdentityWithdraw" : "DeliveredIdentityRequest";

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 text-start">
      <h3 className="font-medium">{t("DeliveredIdentityTitle")}</h3>
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
            <Select value={quoteId} onValueChange={setQuoteId}>
              <SelectTrigger id={field}><SelectValue /></SelectTrigger>
              <SelectContent>{available.options.map((option) => (
                <SelectItem key={option.quoteId} value={option.quoteId}>
                  {option.label} · {formatLocalized(option.quotedAt, "d MMM yyyy", locale)}
                </SelectItem>
              ))}</SelectContent>
            </Select>
            <Button type="button" disabled={!selected} onClick={() => {
              if (selected) open({ mode: "request", quoteId: selected.quoteId,
                handoverAt: available.handoverAt, economicsStamp: available.economicsStamp });
            }}>{t("DeliveredIdentityRequest")}</Button>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(title)}</DialogTitle>
            <DialogDescription>{t(edit?.mode === "withdraw" ? "DeliveredIdentityWithdrawHelp" : "DeliveredIdentityHelp")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-3">
            {edit?.mode === "approve" && <div className="space-y-1">
              <Label htmlFor={`${field}-time`}>{t("DeliveredIdentityReturnTime")}</Label>
              <Input id={`${field}-time`} type="datetime-local" step="1" required value={returnDate}
                onChange={(event) => setReturnDate(event.target.value)} />
            </div>}
            {edit?.mode !== "withdraw" && <div className="space-y-1">
              <Label htmlFor={`${field}-text`}>{t(edit?.mode === "approve" ? "DeliveredIdentityReference" : "DeliveredLenderReason")}</Label>
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
