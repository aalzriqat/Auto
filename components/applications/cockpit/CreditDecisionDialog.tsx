"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The finance company's credit decision, RECORDED — never made.
 *
 * AutoFlow is not the financing company. This dialog writes down what they
 * decided about the application (`applications.updateStatus` to APPROVED or
 * REJECTED); it evaluates nothing. The copy says so, and the two outcomes are
 * offered as equals rather than as a green "approve" and a red "reject", which
 * would read as the dealership passing judgement.
 *
 * Both outcomes are the SAME mutation the Finance Applications → Review dialog
 * calls. Moving the caller here is what lets that dialog be retired; nothing
 * about the server changed.
 *
 * Each outcome is gated on its OWN permission, exactly as the server gates it:
 * approving needs `approve:finance_application` (and never the application's
 * own salesperson), rejecting needs `review:finance_application`. A caller
 * holding one and not the other sees the option they may take and a reason
 * for the one they may not — an option that is merely missing answers nothing.
 */
export type CreditDecision = "APPROVED" | "REJECTED";

export function CreditDecisionDialog({
  open,
  submitting,
  error,
  canApprove,
  canReject,
  isOwnDeal,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  submitting: boolean;
  error: string | null;
  canApprove: boolean;
  canReject: boolean;
  /** The server refuses the application's own salesperson approving it. */
  isOwnDeal: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (decision: CreditDecision) => void | Promise<void>;
}>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {/* The choice lives in a child that Radix UNMOUNTS on close, so every
            opening starts with nothing selected — a previous attempt's choice
            must not be pre-selected on a decision that posts a transition. */}
        <CreditDecisionBody
          submitting={submitting}
          error={error}
          canApprove={canApprove}
          canReject={canReject}
          isOwnDeal={isOwnDeal}
          t={t}
          onClose={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreditDecisionBody({
  submitting,
  error,
  canApprove,
  canReject,
  isOwnDeal,
  t,
  onClose,
  onSubmit,
}: Readonly<{
  submitting: boolean;
  error: string | null;
  canApprove: boolean;
  canReject: boolean;
  isOwnDeal: boolean;
  t: (key: string) => string;
  onClose: () => void;
  onSubmit: (decision: CreditDecision) => void | Promise<void>;
}>) {
  const [decision, setDecision] = useState<CreditDecision | null>(null);
  const approveUnavailable = !canApprove || isOwnDeal;
  const approveReason = !canApprove
    ? "CreditDecisionApproveNeedsPermission"
    : isOwnDeal
      ? "CreditDecisionOwnDeal"
      : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("RecordCreditDecisionTitle")}</DialogTitle>
        <DialogDescription>{t("RecordCreditDecisionDesc")}</DialogDescription>
      </DialogHeader>

      {/* Two outcomes as equals. `role="radio"` inside a `radiogroup`
            so a screen reader announces one control with two options, and a
            refused option stays VISIBLE with its reason rather than vanishing. */}
      <div
        role="radiogroup"
        aria-label={t("RecordCreditDecisionTitle")}
        className="grid gap-2"
      >
        {(
          [
            [
              "APPROVED",
              "CreditDecisionApproved",
              approveReason ?? "CreditDecisionApprovedHint",
              approveUnavailable,
            ],
            [
              "REJECTED",
              "CreditDecisionRejected",
              canReject
                ? "CreditDecisionRejectedHint"
                : "CreditDecisionRejectNeedsPermission",
              !canReject,
            ],
          ] as const
        ).map(([value, labelKey, hintKey, unavailable]) => {
          const selected = decision === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={unavailable}
              data-testid={`credit-decision-${value}`}
              onClick={() => setDecision(value)}
              className={`rounded-md border p-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? "border-primary bg-primary/[0.04] shadow-sm"
                  : "border-border enabled:hover:bg-muted/40"
              }`}
            >
              <span className="block text-sm font-medium">{t(labelKey)}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {t(hintKey)}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter className="gap-2">
        <Button variant="outline" disabled={submitting} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          disabled={submitting || decision === null}
          onClick={() => {
            if (decision) void onSubmit(decision);
          }}
        >
          {t("RecordCreditDecisionConfirm")}
        </Button>
      </DialogFooter>
    </>
  );
}
