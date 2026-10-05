"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { economicDateInputToMs, economicTodayDateInput } from "@/lib/dateInput";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * SCRUM-693 / SCRUM-691 - "Unwind deal": reverse a paid finance deal from the deal page.
 *
 * One dialog, three steps, driven entirely by the server's own `unwindStatus`:
 *   1. START           - record why (the only step with no money).
 *   2. FORWARD RETURN  - only when the dealership had paid the finance company on to it.
 *   3. REFUND + RETURN - refund the full remittance the same way it arrived, issue the credit
 *                        note, and take the car back (it goes into inspection, never straight
 *                        back on sale).
 * The server owns every rule. `eligibility` says which button is live and `refusals` says why
 * not; nothing here re-derives a permission, a period or a figure. Mounted without a trigger:
 * DealCockpit owns the "Unwind deal" button.
 */

type T = (key: string) => string;

export type UnwindStep = "AWAITING_FORWARD_RETURN" | "AWAITING_FINISH" | "COMPLETED" | "ABANDONED";
type Refusal = { code: string; message: string };

/** The slice of `dealUnwind.unwindStatus` this dialog reads. */
export type UnwindStatusView = Readonly<{
  status: "ACTIVE" | "COMPLETED" | "ABANDONED" | null;
  step: UnwindStep | null;
  eligibility: Readonly<{ canStart: boolean; canForwardReturn: boolean; canFinish: boolean; canAbandon: boolean }>;
  refusals: Readonly<{ start?: Refusal; forwardReturn?: Refusal; finish?: Refusal }>;
  /** `null` for a caller who may not read finance figures. */
  evidence: Readonly<{
    remittanceMinor: number;
    remittanceMethod: "BANK_TRANSFER" | "CASH";
    forwardDueMinor: number;
  }> | null;
}>;

export type UnwindFinishValues = Readonly<{
  method: "BANK_TRANSFER" | "CASH";
  refundedAt: number;
  bankReference?: string;
  voucherNumber?: string;
  recipientAcknowledged?: boolean;
  creditNoteReference: string;
  vehicleReturnedAt: number;
  vehicleReturnNote: string;
  customerPaymentDisposition: "REFUND" | "RETAIN_CREDIT";
}>;

const MAX_TEXT_CHARS = 500;
/** The server's cap on reference / voucher / credit-note fields (MAX_DIRECT_PAYMENT_REFERENCE_CHARS). */
const MAX_REFERENCE_CHARS = 200;

/**
 * A picked calendar day as an instant. Today is sent as "now": midnight of today is earlier than the
 * moment the finance company's payment was confirmed, and the server refuses a refund dated before it.
 */
function refundInstant(dateInput: string): number {
  return dateInput === economicTodayDateInput() ? Date.now() : economicDateInputToMs(dateInput);
}

export function UnwindDealDialog({
  open,
  status,
  submitting,
  error,
  formatMinor,
  t,
  onOpenChange,
  onStart,
  onForwardReturn,
  onFinish,
  onAbandon,
}: Readonly<{
  open: boolean;
  status: UnwindStatusView;
  submitting: boolean;
  error: string | null;
  formatMinor: (minor: number) => string;
  t: T;
  onOpenChange: (open: boolean) => void;
  onStart: (reason: string) => void | Promise<void>;
  onForwardReturn: (values: { returnedAt: number; reference: string }) => void | Promise<void>;
  onFinish: (values: UnwindFinishValues) => void | Promise<void>;
  onAbandon: (reason: string) => void | Promise<void>;
}>) {
  const active = status.status === "ACTIVE";
  // The forward step exists only for a deal that paid the finance company on; while no unwind is
  // active the server has not said, so the stepper shows it only once it is known.
  const hasForward = active && (status.step === "AWAITING_FORWARD_RETURN" || (status.evidence?.forwardDueMinor ?? 0) > 0);
  const current: "START" | "FORWARD" | "FINISH" = !active
    ? "START"
    : status.step === "AWAITING_FORWARD_RETURN"
      ? "FORWARD"
      : "FINISH";
  const steps: ReadonlyArray<{ key: "START" | "FORWARD" | "FINISH"; labelKey: string }> = [
    { key: "START", labelKey: "UnwindStepStart" },
    ...(hasForward ? [{ key: "FORWARD" as const, labelKey: "UnwindStepForward" }] : []),
    { key: "FINISH", labelKey: "UnwindStepFinish" },
  ];
  const currentIndex = steps.findIndex((s) => s.key === current);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="deal-unwind-dialog">
        <DialogHeader>
          <DialogTitle>{t("UnwindDealTitle")}</DialogTitle>
          <DialogDescription>{t("UnwindDealDesc")}</DialogDescription>
        </DialogHeader>

        <ol className="flex items-center gap-2 text-xs" aria-label={t("UnwindStepsLabel")} data-testid="deal-unwind-steps">
          {steps.map((step, index) => {
            const done = index < currentIndex;
            const here = index === currentIndex;
            return (
              <li
                key={step.key}
                aria-current={here ? "step" : undefined}
                data-state={done ? "done" : here ? "current" : "todo"}
                className={cn(
                  "flex min-w-0 items-center gap-1.5 border-b-2 pb-1.5", here ? "flex-[2] sm:flex-1" : "flex-none sm:flex-1",
                  here ? "border-primary font-medium text-foreground" : done ? "border-primary/40 text-muted-foreground" : "border-border text-muted-foreground"
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                    done ? "border-primary bg-primary text-primary-foreground" : here ? "border-primary" : "border-border"
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : index + 1}
                </span>
                <span className={cn("truncate", !here && "hidden sm:inline")}>{t(step.labelKey)}</span>
              </li>
            );
          })}
        </ol>

        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-sm text-destructive" data-testid="deal-unwind-error">
            {error}
          </p>
        )}

        {current === "START" && (
          <StartStep status={status} submitting={submitting} t={t} onStart={onStart} onClose={() => onOpenChange(false)} />
        )}
        {current === "FORWARD" && (
          <ForwardStep
            status={status}
            submitting={submitting}
            formatMinor={formatMinor}
            t={t}
            onSubmit={onForwardReturn}
          />
        )}
        {current === "FINISH" && (
          <FinishStep status={status} submitting={submitting} formatMinor={formatMinor} t={t} onSubmit={onFinish} />
        )}

        {active && status.eligibility.canAbandon && (
          <AbandonControl submitting={submitting} t={t} onAbandon={onAbandon} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A server refusal in the caller's language; the English text is the fallback for an uncoded one. */
function refusalText(refusal: Refusal, t: T): string {
  const key = `ServerError_${refusal.code}`;
  const text = t(key);
  return text === key ? refusal.message : text;
}

function RefusalNote({ refusal, t, testId }: Readonly<{ refusal?: Refusal; t: T; testId: string }>) {
  if (!refusal) return null;
  return (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-sm" data-testid={testId}>
      {refusalText(refusal, t)}
    </p>
  );
}

function StartStep({
  status,
  submitting,
  t,
  onStart,
  onClose,
}: Readonly<{
  status: UnwindStatusView;
  submitting: boolean;
  t: T;
  onStart: (reason: string) => void | Promise<void>;
  onClose: () => void;
}>) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <>
      <form
        id="deal-unwind-start-form"
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "") return;
          void onStart(trimmed);
        }}
      >
        <p className="text-sm text-muted-foreground">{t("UnwindStartExplain")}</p>
        <Label htmlFor="deal-unwind-reason">{t("UnwindReasonLabel")}</Label>
        <Textarea
          id="deal-unwind-reason"
          rows={3}
          required
          maxLength={MAX_TEXT_CHARS}
          value={reason}
          disabled={submitting}
          onChange={(event) => setReason(event.target.value)}
        />
      </form>
      <RefusalNote refusal={status.refusals.start} t={t} testId="deal-unwind-start-refusal" />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          type="submit"
          form="deal-unwind-start-form"
          variant="destructive"
          data-testid="deal-unwind-start"
          disabled={submitting || trimmed === "" || !status.eligibility.canStart}
        >
          {submitting && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
          {t("UnwindStartAction")}
        </Button>
      </DialogFooter>
    </>
  );
}

function ForwardStep({
  status,
  submitting,
  formatMinor,
  t,
  onSubmit,
}: Readonly<{
  status: UnwindStatusView;
  submitting: boolean;
  formatMinor: (minor: number) => string;
  t: T;
  onSubmit: (values: { returnedAt: number; reference: string }) => void | Promise<void>;
}>) {
  const [date, setDate] = useState(economicTodayDateInput());
  const [reference, setReference] = useState("");
  const trimmed = reference.trim();
  const due = status.evidence?.forwardDueMinor;
  return (
    <>
      <form
        id="deal-unwind-forward-form"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "" || date === "") return;
          void onSubmit({ returnedAt: economicDateInputToMs(date), reference: trimmed });
        }}
      >
        <p className="text-sm text-muted-foreground">{t("UnwindForwardExplain")}</p>
        {due !== undefined && due > 0 && (
          <p className="text-sm font-medium" data-testid="deal-unwind-forward-due">
            {t("UnwindForwardDueLabel")}: <span dir="ltr">{formatMinor(due)}</span>
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="deal-unwind-forward-date">{t("UnwindForwardDateLabel")}</Label>
          <Input
            id="deal-unwind-forward-date"
            type="date"
            required
            value={date}
            max={economicTodayDateInput()}
            disabled={submitting}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deal-unwind-forward-ref">{t("UnwindForwardReferenceLabel")}</Label>
          <Input
            id="deal-unwind-forward-ref"
            required
            maxLength={MAX_REFERENCE_CHARS}
            value={reference}
            disabled={submitting}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
      </form>
      <RefusalNote refusal={status.refusals.forwardReturn} t={t} testId="deal-unwind-forward-refusal" />
      <DialogFooter>
        <Button
          type="submit"
          form="deal-unwind-forward-form"
          data-testid="deal-unwind-forward-submit"
          disabled={submitting || trimmed === "" || date === "" || !status.eligibility.canForwardReturn}
        >
          {submitting && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
          {t("UnwindForwardAction")}
        </Button>
      </DialogFooter>
    </>
  );
}

function FinishStep({
  status,
  submitting,
  formatMinor,
  t,
  onSubmit,
}: Readonly<{
  status: UnwindStatusView;
  submitting: boolean;
  formatMinor: (minor: number) => string;
  t: T;
  onSubmit: (values: UnwindFinishValues) => void | Promise<void>;
}>) {
  // The refund goes back the way the money arrived; the server refuses any other method.
  const method = status.evidence?.remittanceMethod;
  const [refundedDate, setRefundedDate] = useState(economicTodayDateInput());
  const [bankReference, setBankReference] = useState("");
  const [voucherNumber, setVoucherNumber] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [creditNote, setCreditNote] = useState("");
  const [vehicleDate, setVehicleDate] = useState(economicTodayDateInput());
  const [vehicleNote, setVehicleNote] = useState("");
  const [disposition, setDisposition] = useState<"REFUND" | "RETAIN_CREDIT" | "">("");

  const evidenceOk =
    method === "BANK_TRANSFER" ? bankReference.trim() !== "" : method === "CASH" ? voucherNumber.trim() !== "" && acknowledged : false;
  const complete =
    evidenceOk &&
    refundedDate !== "" &&
    vehicleDate !== "" &&
    creditNote.trim() !== "" &&
    vehicleNote.trim() !== "" &&
    disposition !== "";

  return (
    <>
      <form
        id="deal-unwind-finish-form"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!complete || !method) return;
          void onSubmit({
            method,
            refundedAt: refundInstant(refundedDate),
            ...(method === "BANK_TRANSFER"
              ? { bankReference: bankReference.trim() }
              : { voucherNumber: voucherNumber.trim(), recipientAcknowledged: acknowledged }),
            creditNoteReference: creditNote.trim(),
            vehicleReturnedAt: economicDateInputToMs(vehicleDate),
            vehicleReturnNote: vehicleNote.trim(),
            customerPaymentDisposition: disposition,
          });
        }}
      >
        <p className="text-sm text-muted-foreground">{t("UnwindFinishExplain")}</p>
        {status.evidence && (
          <p className="text-sm font-medium" data-testid="deal-unwind-refund-amount">
            {t("UnwindRefundAmountLabel")}: <span dir="ltr">{formatMinor(status.evidence.remittanceMinor)}</span>
            {" · "}
            {t(method === "CASH" ? "UnwindMethodCash" : "UnwindMethodBank")}
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="deal-unwind-refund-date">{t("UnwindRefundDateLabel")}</Label>
          <Input
            id="deal-unwind-refund-date"
            type="date"
            required
            value={refundedDate}
            max={economicTodayDateInput()}
            disabled={submitting}
            onChange={(event) => setRefundedDate(event.target.value)}
          />
        </div>
        {method === "BANK_TRANSFER" && (
          <div className="space-y-1.5">
            <Label htmlFor="deal-unwind-bank-ref">{t("UnwindBankReferenceLabel")}</Label>
            <Input
              id="deal-unwind-bank-ref"
              required
              maxLength={MAX_REFERENCE_CHARS}
              value={bankReference}
              disabled={submitting}
              onChange={(event) => setBankReference(event.target.value)}
            />
          </div>
        )}
        {method === "CASH" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="deal-unwind-voucher">{t("UnwindVoucherLabel")}</Label>
              <Input
                id="deal-unwind-voucher"
                required
                maxLength={MAX_REFERENCE_CHARS}
                value={voucherNumber}
                disabled={submitting}
                onChange={(event) => setVoucherNumber(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="deal-unwind-ack"
                checked={acknowledged}
                disabled={submitting}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <Label htmlFor="deal-unwind-ack">{t("UnwindAcknowledgedLabel")}</Label>
            </div>
          </>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="deal-unwind-credit-note">{t("UnwindCreditNoteLabel")}</Label>
          <Input
            id="deal-unwind-credit-note"
            required
            maxLength={MAX_REFERENCE_CHARS}
            value={creditNote}
            disabled={submitting}
            onChange={(event) => setCreditNote(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deal-unwind-vehicle-date">{t("UnwindVehicleDateLabel")}</Label>
          <Input
            id="deal-unwind-vehicle-date"
            type="date"
            required
            value={vehicleDate}
            max={economicTodayDateInput()}
            disabled={submitting}
            onChange={(event) => setVehicleDate(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deal-unwind-vehicle-note">{t("UnwindVehicleNoteLabel")}</Label>
          <Textarea
            id="deal-unwind-vehicle-note"
            rows={2}
            required
            maxLength={MAX_TEXT_CHARS}
            value={vehicleNote}
            disabled={submitting}
            onChange={(event) => setVehicleNote(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("UnwindVehicleInspectionNote")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deal-unwind-disposition">{t("UnwindDispositionLabel")}</Label>
          <Select
            value={disposition}
            onValueChange={(value) => setDisposition(value === "REFUND" || value === "RETAIN_CREDIT" ? value : "")}
            disabled={submitting}
          >
            <SelectTrigger id="deal-unwind-disposition">
              <SelectValue placeholder={t("UnwindDispositionPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="REFUND">{t("UnwindDispositionRefund")}</SelectItem>
              <SelectItem value="RETAIN_CREDIT">{t("UnwindDispositionCredit")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </form>
      <RefusalNote refusal={status.refusals.finish} t={t} testId="deal-unwind-finish-refusal" />
      <DialogFooter>
        <Button
          type="submit"
          form="deal-unwind-finish-form"
          variant="destructive"
          data-testid="deal-unwind-finish-submit"
          disabled={submitting || !complete || !status.eligibility.canFinish}
        >
          {submitting && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
          {t("UnwindFinishAction")}
        </Button>
      </DialogFooter>
    </>
  );
}

function AbandonControl({
  submitting,
  t,
  onAbandon,
}: Readonly<{ submitting: boolean; t: T; onAbandon: (reason: string) => void | Promise<void> }>) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const wasAsking = useRef(false);
  useEffect(() => {
    if (asking && !wasAsking.current) setReason("");
    wasAsking.current = asking;
  }, [asking]);
  const trimmed = reason.trim();

  if (!asking) {
    return (
      <div className="border-t pt-3">
        <Button type="button" variant="ghost" size="sm" disabled={submitting} data-testid="deal-unwind-abandon" onClick={() => setAsking(true)}>
          {t("UnwindAbandonAction")}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm text-muted-foreground">{t("UnwindAbandonExplain")}</p>
      <Label htmlFor="deal-unwind-abandon-reason">{t("UnwindReasonLabel")}</Label>
      <Textarea
        id="deal-unwind-abandon-reason"
        rows={2}
        maxLength={MAX_TEXT_CHARS}
        value={reason}
        disabled={submitting}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => setAsking(false)}>
          {t("Cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-testid="deal-unwind-abandon-confirm"
          disabled={submitting || trimmed === ""}
          onClick={() => void onAbandon(trimmed)}
        >
          {submitting && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
          {t("UnwindAbandonConfirm")}
        </Button>
      </div>
    </div>
  );
}
