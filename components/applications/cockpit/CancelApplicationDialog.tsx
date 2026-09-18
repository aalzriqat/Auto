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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type CancelApplicationValues = {
  reason?: string;
  failureReason?: string;
  appraisalFeeResponsibility?: string;
  appraisalFeeResponsibilityReason?: string;
};

/**
 * Voiding the application — the same `applications.cancelApplication` the
 * Finance Applications → Review dialog calls, with the same two warnings.
 *
 * The CLOSED warning is the one that matters: cancelling a finalized deal
 * voids the sale, restores the vehicle and reverses the posted accounting.
 * The server refuses once disbursement funds are confirmed received; the copy
 * says so before the operator finds out by refusal.
 */
export function CancelApplicationDialog({
  open,
  submitting,
  error,
  isClosed,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  submitting: boolean;
  error: string | null;
  /** A CLOSED deal: cancelling reverses a posted sale, not just a request. */
  isClosed: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CancelApplicationValues) => void | Promise<void>;
}>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {/* The fields live in a child Radix UNMOUNTS on close, so an abandoned
            attempt's text never survives into the next one. */}
        <CancelApplicationBody
          submitting={submitting}
          error={error}
          isClosed={isClosed}
          t={t}
          onClose={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

const FAILURE_REASONS = [
  { value: "APPRAISAL_TOO_LOW", labelKey: "FailureReasonAppraisalTooLow" },
  { value: "CUSTOMER_WITHDREW", labelKey: "FailureReasonCustomerWithdrew" },
  { value: "CREDIT_REJECTED", labelKey: "FailureReasonCreditRejected" },
  { value: "DOCUMENTS_INCOMPLETE", labelKey: "FailureReasonDocsIncomplete" },
  { value: "DEALER_REJECTED_ECONOMICS", labelKey: "FailureReasonDealerRejected" },
  { value: "CUSTOMER_REJECTED_GAP", labelKey: "FailureReasonCustomerRejectedGap" },
  { value: "GAP_NEGOTIATION_FAILED", labelKey: "FailureReasonGapFailed" },
  { value: "OTHER", labelKey: "FailureReasonOther" },
] as const;

const FEE_RESPONSIBILITIES = [
  { value: "DEALER", labelKey: "ResponsibilityDealer" },
  { value: "CUSTOMER", labelKey: "ResponsibilityCustomer" },
  { value: "FINANCE_COMPANY", labelKey: "ResponsibilityFinanceCompany" },
  { value: "EMPLOYEE", labelKey: "ResponsibilityEmployee" },
  { value: "UNRESOLVED", labelKey: "ResponsibilityUnresolved" },
] as const;

function CancelApplicationBody({
  submitting,
  error,
  isClosed,
  t,
  onClose,
  onSubmit,
}: Readonly<{
  submitting: boolean;
  error: string | null;
  isClosed: boolean;
  t: (key: string) => string;
  onClose: () => void;
  onSubmit: (values: CancelApplicationValues) => void | Promise<void>;
}>) {
  const [reason, setReason] = useState("");
  const [failureReason, setFailureReason] = useState<string>("");
  const [appraisalFeeResponsibility, setAppraisalFeeResponsibility] = useState<string>("");
  const [appraisalFeeResponsibilityReason, setAppraisalFeeResponsibilityReason] = useState("");

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("ConfirmCancelApplication")}</DialogTitle>
        <DialogDescription>
          {isClosed
            ? t("CancelClosedApplicationWarning")
            : t("CancelApplicationWarning")}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* Failure reason selector */}
        <div className="space-y-1.5">
          <Label htmlFor="cancel-failure-reason" className="text-sm font-medium">
            {t("FailureReasonLabel")}
          </Label>
          <Select
            value={failureReason}
            onValueChange={setFailureReason}
            disabled={submitting}
          >
            <SelectTrigger id="cancel-failure-reason">
              <SelectValue placeholder={t("FailureReasonOptional")} />
            </SelectTrigger>
            <SelectContent>
              {FAILURE_REASONS.map((fr) => (
                <SelectItem key={fr.value} value={fr.value}>
                  {t(fr.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Appraisal fee responsibility */}
        <div className="space-y-1.5">
          <Label htmlFor="cancel-appraisal-fee-responsibility" className="text-sm font-medium">
            {t("AppraisalFeeResponsibilityLabel")}
          </Label>
          <Select
            value={appraisalFeeResponsibility}
            onValueChange={setAppraisalFeeResponsibility}
            disabled={submitting}
          >
            <SelectTrigger id="cancel-appraisal-fee-responsibility">
              <SelectValue placeholder={t("AppraisalFeeResponsibilityOptional")} />
            </SelectTrigger>
            <SelectContent>
              {FEE_RESPONSIBILITIES.map((resp) => (
                <SelectItem key={resp.value} value={resp.value}>
                  {t(resp.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {appraisalFeeResponsibility && (
          <div className="space-y-1.5">
            <Label htmlFor="cancel-fee-responsibility-reason" className="text-sm font-medium">
              {t("AppraisalFeeResponsibilityReasonLabel")}
            </Label>
            <Input
              id="cancel-fee-responsibility-reason"
              value={appraisalFeeResponsibilityReason}
              onChange={(e) => setAppraisalFeeResponsibilityReason(e.target.value)}
              placeholder={t("AppraisalFeeResponsibilityReasonPlaceholder")}
              disabled={submitting}
            />
          </div>
        )}

        {/* Free-form notes / reason */}
        <div className="space-y-1.5">
          <Label
            htmlFor="cancel-application-reason"
            className="text-sm font-medium"
          >
            {t("CancellationReasonLabel")}
          </Label>
          <Textarea
            id="cancel-application-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("CancellationReasonPlaceholder")}
            rows={3}
            disabled={submitting}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter className="gap-2">
        <Button variant="outline" disabled={submitting} onClick={onClose}>
          {t("KeepApplication")}
        </Button>
        <Button
          variant="destructive"
          disabled={submitting}
          onClick={() =>
            void onSubmit({
              reason: reason.trim() || undefined,
              failureReason: failureReason || undefined,
              appraisalFeeResponsibility: appraisalFeeResponsibility || undefined,
              appraisalFeeResponsibilityReason:
                appraisalFeeResponsibilityReason.trim() || undefined,
            })
          }
        >
          {t("CancelApplication")}
        </Button>
      </DialogFooter>
    </>
  );
}
