"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import type { Id } from "@/convex/_generated/dataModel";
import { economicDateInputToMs, economicTodayDateInput } from "@/lib/dateInput";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The dialogs behind the custody panel's money actions. Each collects ONE
 * command's inputs and hands them up; nothing here computes a balance, picks
 * an account or decides whether the command is allowed — the server refuses
 * and the panel shows the refusal beside the form.
 *
 * Amounts are typed in MAJOR units and scaled here with the record's own
 * currency scale, then sent as integers; a non-finite entry never leaves the
 * form. `!(x > 0)` rather than `x <= 0` throughout: they differ on NaN.
 */

type T = (key: string) => string;

/**
 * Ids here are the server's own `Id<...>` types end to end: a dialog's
 * `<Select>` holds a string, and the value it hands up is the matching
 * entry from the list the server served — never that string re-labelled
 * with a cast. A selection that matches nothing is not submittable.
 */
export type CustodyMember = Readonly<{
  userId: Id<"users">;
  name: string;
  /**
   * The signed-in operator. A plan may name them; an issuance may not
   * (`openDealCustody` refuses self-issuance), so the issue picker withholds
   * this row rather than offer a choice the server will refuse.
   */
  isActor?: boolean;
}>;

export type CustodyMovementValues = Readonly<{
  /**
   * The dialog ATTEMPT these values belong to, minted once when the dialog
   * opened (R8). The container's command identity is derived from it and
   * nothing in the payload: a retry of the same open dialog — even with a
   * corrected figure — is the same command, judged by the server's
   * fingerprint; a dialog opened again for an identical figure is a new one.
   */
  intentId: string;
  amountMinor: number;
  method: PaymentMethod;
  reference?: string;
  occurredAt?: number;
  note?: string;
  /** Only on an issuance that OPENS a record: who receives the cash. */
  userId?: Id<"users">;
}>;

/** Major-unit text → minor integer, or null when it is not a positive finite figure. */
export function parseMajorToMinor(text: string, scale: number): number | null {
  const parsed = Number(text);
  if (text.trim() === "" || !Number.isFinite(parsed) || !(parsed > 0)) return null;
  const minor = Math.round(parsed * Math.pow(10, scale));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function useResetOnOpen(open: boolean, reset: () => void): void {
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (justOpened) reset();
    // `reset` closes over the values the dialog opened with, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/**
 * ## A dialog whose command is in flight is not closable by ANY route (R9)
 *
 * Every submit of an open dialog carries the attempt's `intentId`; closing
 * the dialog ABANDONS the attempt and the container retires that identity
 * (`onAbandonMove` and its siblings). Only Cancel was disabled while busy:
 * Escape, the overlay and the corner X still went through `onOpenChange`,
 * so an operator could abandon an attempt whose request was still on the
 * wire. If that request then landed, the money moved under an identity the
 * screen had already forgotten — and the next dialog for the same figures
 * was a NEW command, so a genuine retry paid twice with no replay to stop
 * it. So while `busy`, every close route is refused: the controlled
 * `onOpenChange(false)` is dropped (which is what the X asks for), and the
 * escape and outside-interaction events are cancelled at the layer so the
 * primitive never asks. The dialog reopens its close routes the moment the
 * attempt settles — success closes it through the container, a lost
 * response keeps it open with the failure shown and the SAME identity for
 * the retry, and a definitive refusal is the container's to retire.
 *
 * One rule for every custody dialog, so no door is guarded differently.
 */
function busyCloseGuard(busy: boolean, onOpenChange: (open: boolean) => void) {
  const refuse = (event: { preventDefault: () => void }) => {
    if (busy) event.preventDefault();
  };
  return {
    onOpenChange: (open: boolean) => {
      if (!open && busy) return;
      onOpenChange(open);
    },
    /** Spread onto `DialogContent`: the routes the primitive would otherwise dismiss on. */
    content: { onEscapeKeyDown: refuse, onPointerDownOutside: refuse, onInteractOutside: refuse },
  };
}

function SubmitError({ message }: Readonly<{ message: string | null }>) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-medium text-destructive">
      {message}
    </p>
  );
}

/** Hand over / return / reimburse. `kind` decides the copy, the bounds and the default method. */
export function CustodyMovementDialog({
  open,
  intentId,
  kind,
  currency,
  scale,
  busy,
  error,
  members,
  defaultUserId,
  suggestedMinor,
  maxMinor,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  /** This attempt's identity; every submit of this open dialog carries it. */
  intentId: string;
  kind: "ISSUED" | "RETURNED" | "REIMBURSED";
  currency: string;
  scale: number;
  busy: boolean;
  error: string | null;
  /** Present only when this issuance opens a record and must name the recipient. */
  members?: ReadonlyArray<CustodyMember>;
  defaultUserId?: Id<"users">;
  /** Prefilled, editable: the recommendation (issue) or what is owed (reimburse). */
  suggestedMinor?: number | null;
  /** The server's own ceiling (a return cannot exceed what was issued); shown before the round trip. */
  maxMinor?: number;
  money: (minor: number, currency: string) => string;
  t: T;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CustodyMovementValues) => void;
}>) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [userId, setUserId] = useState<string>("");
  useResetOnOpen(open, () => {
    setAmount(suggestedMinor ? String(suggestedMinor / Math.pow(10, scale)) : "");
    setMethod("CASH");
    setReference("");
    setDate("");
    setNote("");
    setUserId(defaultUserId ?? "");
  });

  const minor = parseMajorToMinor(amount, scale);
  const entered = amount.trim() !== "";
  const invalid = entered && minor === null;
  const exceeds = minor !== null && maxMinor !== undefined && minor > maxMinor;
  const needsPerson = members !== undefined;
  // The recipient is the served row the selection names; an id that is not
  // in the list (stale default, empty picker) is not one to move money to.
  const recipient = needsPerson ? members.find((member) => member.userId === userId) : undefined;
  const canSubmit = minor !== null && !exceeds && !busy && (!needsPerson || recipient !== undefined);

  const copy = {
    ISSUED: { title: "CustodyIssueTitle", desc: "CustodyIssueDesc", cta: "CustodyIssueCash", exceed: "CustodyAmountExceedsIssued" },
    RETURNED: { title: "CustodyReturnTitle", desc: "CustodyReturnDesc", cta: "CustodyRecordReturn", exceed: "CustodyAmountExceedsIssued" },
    REIMBURSED: { title: "CustodyReimburseTitle", desc: "CustodyReimburseDesc", cta: "CustodyReimburse", exceed: "CustodyAmountExceedsOwed" },
  }[kind];
  const id = `custody-${kind.toLowerCase()}`;
  const guard = busyCloseGuard(busy, onOpenChange);

  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="max-w-md" data-testid={`${id}-dialog`} {...guard.content}>
        <DialogHeader>
          <DialogTitle>{t(copy.title)}</DialogTitle>
          <DialogDescription>{t(copy.desc)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {needsPerson && (
            <div className="space-y-1.5">
              <Label>{t("CustodyAssignPerson")}</Label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger aria-label={t("CustodyAssignPerson")} data-testid={`${id}-person`}>
                  <SelectValue placeholder={t("CustodyAssignPersonPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      <bdi>{member.name}</bdi>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-amount`}>
              {t("CustodyAmount")} <span className="text-muted-foreground">({currency})</span>
            </Label>
            <Input
              id={`${id}-amount`}
              inputMode="decimal"
              value={amount}
              aria-invalid={invalid || exceeds}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular-nums"
              dir="ltr"
            />
            {invalid && (
              <p role="alert" className="text-xs font-medium text-destructive">{t("CustodyAmountInvalid")}</p>
            )}
            {exceeds && maxMinor !== undefined && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t(copy.exceed)} <bdi dir="ltr" className="tabular-nums">{money(maxMinor, currency)}</bdi>
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{t("CustodyAccount")}</Label>
            <PaymentMethodSelect t={t} value={method} onValueChange={setMethod} ariaLabel={t("CustodyAccount")} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-reference`}>{t("CustodyReference")}</Label>
              <Input id={`${id}-reference`} value={reference} onChange={(e) => setReference(e.target.value)} dir="ltr" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-date`}>{t("CustodyDate")}</Label>
              <Input id={`${id}-date`} type="date" value={date} max={economicTodayDateInput()} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-note`}>{t("CustodyNoteField")}</Label>
            <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <SubmitError message={error} />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            data-testid={`${id}-submit`}
            onClick={() =>
              minor !== null &&
              onSubmit({
                intentId,
                amountMinor: minor,
                method,
                reference: reference.trim() || undefined,
                note: note.trim() || undefined,
                // The picked calendar day, exactly, as its UTC midnight; blank means "now".
                occurredAt: date ? economicDateInputToMs(date) : undefined,
                userId: recipient?.userId,
              })
            }
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin me-2" aria-hidden />}
            {t(copy.cta)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Who will handle the payments — a plan, before any cash moves. */
export function CustodyPlanDialog({
  open,
  members,
  currency,
  scale,
  current,
  busy,
  error,
  t,
  onOpenChange,
  onSubmit,
  onClear,
}: Readonly<{
  open: boolean;
  members: ReadonlyArray<CustodyMember>;
  currency: string;
  scale: number;
  current: { userId: Id<"users">; amountMinor: number | null; note: string | null } | null;
  busy: boolean;
  error: string | null;
  t: T;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { userId: Id<"users">; amountMinor?: number; note?: string }) => void;
  onClear: () => void;
}>) {
  const [userId, setUserId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  useResetOnOpen(open, () => {
    setUserId(current?.userId ?? "");
    setAmount(current?.amountMinor ? String(current.amountMinor / Math.pow(10, scale)) : "");
    setNote(current?.note ?? "");
  });
  const minor = parseMajorToMinor(amount, scale);
  const invalid = amount.trim() !== "" && minor === null;
  const handler = members.find((member) => member.userId === userId);
  const canSubmit = handler !== undefined && !invalid && !busy;
  const guard = busyCloseGuard(busy, onOpenChange);

  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="max-w-md" data-testid="custody-plan-dialog" {...guard.content}>
        <DialogHeader>
          <DialogTitle>{t("CustodyAssignTitle")}</DialogTitle>
          <DialogDescription>{t("CustodyAssignDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("CustodyAssignPerson")}</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger aria-label={t("CustodyAssignPerson")} data-testid="custody-plan-person">
                <SelectValue placeholder={t("CustodyAssignPersonPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {members.map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    <bdi>{member.name}</bdi>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custody-plan-amount">
              {t("CustodyPlannedAmount")} <span className="text-muted-foreground">({currency})</span>
            </Label>
            <Input id="custody-plan-amount" inputMode="decimal" value={amount} aria-invalid={invalid} onChange={(e) => setAmount(e.target.value)} className="tabular-nums" dir="ltr" />
            {invalid && <p role="alert" className="text-xs font-medium text-destructive">{t("CustodyAmountInvalid")}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custody-plan-note">{t("CustodyPlanNote")}</Label>
            <Input id="custody-plan-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <SubmitError message={error} />
        </div>
        <DialogFooter className="sm:justify-between">
          {current ? (
            <Button type="button" variant="ghost" onClick={onClear} disabled={busy} data-testid="custody-plan-clear">
              {t("CustodyClearPlan")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              disabled={!canSubmit}
              data-testid="custody-plan-submit"
              onClick={() => handler && onSubmit({ userId: handler.userId, amountMinor: minor ?? undefined, note: note.trim() || undefined })}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin me-2" aria-hidden />}
              {t("Save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type CustodyEligibleFee = Readonly<{
  _id: Id<"financeDealFees">;
  label: string;
  actualAmountMinor: number;
  currency: string;
}>;

/** Charge one of the deal's eligible employee-paid costs to this custody record. */
export function CustodyAttachDialog({
  open,
  fees,
  busy,
  error,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  fees: ReadonlyArray<CustodyEligibleFee>;
  busy: boolean;
  error: string | null;
  money: (minor: number, currency: string) => string;
  t: T;
  onOpenChange: (open: boolean) => void;
  onSubmit: (feeId: Id<"financeDealFees">) => void;
}>) {
  const [feeId, setFeeId] = useState<string>("");
  useResetOnOpen(open, () => setFeeId(fees.length === 1 ? fees[0]._id : ""));
  const picked = fees.find((fee) => fee._id === feeId);
  const guard = busyCloseGuard(busy, onOpenChange);
  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="max-w-md" data-testid="custody-attach-dialog" {...guard.content}>
        <DialogHeader>
          <DialogTitle>{t("CustodyAttachTitle")}</DialogTitle>
          <DialogDescription>{t("CustodyAttachDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {fees.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="custody-attach-none">{t("CustodyAttachNone")}</p>
          ) : (
            <div className="space-y-1.5">
              <Label>{t("CustodyAttachPick")}</Label>
              <Select value={feeId} onValueChange={setFeeId}>
                <SelectTrigger aria-label={t("CustodyAttachPick")} data-testid="custody-attach-pick">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fees.map((fee) => (
                    <SelectItem key={fee._id} value={fee._id}>
                      <bdi>{fee.label}</bdi> · <bdi dir="ltr" className="tabular-nums">{money(fee.actualAmountMinor, fee.currency)}</bdi>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <SubmitError message={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button type="button" disabled={picked === undefined || busy} data-testid="custody-attach-submit" onClick={() => picked && onSubmit(picked._id)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin me-2" aria-hidden />}
            {t("CustodyAttachCost")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a closure submits; `intentId` is the attempt's, as on a movement. */
export type CustodyCloseValues = Readonly<{
  intentId: string;
  notes: string;
  writeOffReason?: string;
}>;

/** Reconcile & close, with the write-off path shown only when a debit residual exists. */
export function CustodyCloseDialog({
  open,
  intentId,
  settled,
  employeeOwesMinor,
  currency,
  busy,
  error,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  /** This attempt's identity; every submit of this open dialog carries it. */
  intentId: string;
  settled: boolean;
  employeeOwesMinor: number;
  currency: string;
  busy: boolean;
  error: string | null;
  money: (minor: number, currency: string) => string;
  t: T;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CustodyCloseValues) => void;
}>) {
  const [notes, setNotes] = useState("");
  const [writeOff, setWriteOff] = useState(false);
  const [reason, setReason] = useState("");
  useResetOnOpen(open, () => {
    setNotes("");
    setWriteOff(false);
    setReason("");
  });
  const canWriteOff = !settled && employeeOwesMinor > 0;
  const canSubmit = notes.trim() !== "" && !busy && (!writeOff || reason.trim() !== "") && (settled || writeOff);
  const guard = busyCloseGuard(busy, onOpenChange);
  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="max-w-md" data-testid="custody-close-dialog" {...guard.content}>
        <DialogHeader>
          <DialogTitle>{t("CustodyCloseTitle")}</DialogTitle>
          <DialogDescription>{t("CustodyCloseDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="custody-close-notes">{t("CustodyCloseNotes")}</Label>
            <Textarea id="custody-close-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
          {canWriteOff && (
            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={writeOff} onCheckedChange={(v) => setWriteOff(v === true)} data-testid="custody-write-off-toggle" />
                <span>
                  {t("CustodyWriteOffToggle")}{" "}
                  <bdi dir="ltr" className="font-medium tabular-nums">{money(employeeOwesMinor, currency)}</bdi>
                  <span className="block text-xs text-muted-foreground">{t("CustodyWriteOffDesc")}</span>
                </span>
              </label>
              {writeOff && (
                <div className="space-y-1.5">
                  <Label htmlFor="custody-write-off-reason">{t("CustodyWriteOffReason")}</Label>
                  <Input id="custody-write-off-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              )}
            </div>
          )}
          <SubmitError message={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            data-testid="custody-close-submit"
            onClick={() => onSubmit({ intentId, notes: notes.trim(), writeOffReason: writeOff ? reason.trim() : undefined })}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin me-2" aria-hidden />}
            {t("CustodyClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reopen, or reverse one movement: a reason and a confirmation. */
export function CustodyReasonDialog({
  open,
  variant,
  detail,
  busy,
  error,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  variant: "REOPEN" | "REVERSE";
  /** The movement being reversed, spelled by the caller. */
  detail?: string;
  busy: boolean;
  error: string | null;
  t: T;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
}>) {
  const [reason, setReason] = useState("");
  useResetOnOpen(open, () => setReason(""));
  const copy = variant === "REOPEN"
    ? { title: "CustodyReopenTitle", desc: "CustodyReopenDesc", cta: "CustodyReopen" }
    : { title: "CustodyReverseTitle", desc: "CustodyReverseDesc", cta: "CustodyReverse" };
  const guard = busyCloseGuard(busy, onOpenChange);
  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="max-w-md" data-testid={`custody-${variant.toLowerCase()}-dialog`} {...guard.content}>
        <DialogHeader>
          <DialogTitle>{t(copy.title)}</DialogTitle>
          <DialogDescription>{t(copy.desc)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {detail && (
            <p className="text-sm font-medium" data-testid="custody-reverse-detail">
              <bdi>{detail}</bdi>
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`custody-${variant}-reason`}>{t("CustodyReason")}</Label>
            <Input id={`custody-${variant}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <SubmitError message={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            variant={variant === "REVERSE" ? "destructive" : "default"}
            disabled={reason.trim() === "" || busy}
            data-testid={`custody-${variant.toLowerCase()}-submit`}
            onClick={() => onSubmit(reason.trim())}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin me-2" aria-hidden />}
            {t(copy.cta)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
