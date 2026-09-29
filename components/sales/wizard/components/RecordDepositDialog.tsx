"use client";

import { useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { getErrorMessage } from "@/lib/errors";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";

const depositSchema = z.object({
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  notes: z.string().optional(),
});

type DepositFormValues = z.infer<typeof depositSchema>;

interface RecordDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: Id<"quotes">;
  /** A manager or accountant recorded the money: it is now held. */
  onRecorded: (depositId: Id<"deposits">) => void;
  /** A salesperson asked for it: nothing is held until it is confirmed. */
  onRequested?: (requestId: Id<"depositRequests">) => void;
}

/**
 * Two doors, one dialog, chosen by authority rather than by a switch the user
 * flips (SCRUM-444, owner Option B).
 *
 * - Holders of `confirm:finance_disbursement` (manager, accountant, owner)
 *   record a deposit they have RECEIVED — and must say how, because the method
 *   picks the account the money is debited to. There is no default.
 * - Everybody else records a REQUEST. It moves no money and holds no vehicle
 *   until a manager or accountant confirms it, so it says so in the dialog
 *   rather than after the fact.
 */
export function RecordDepositDialog({
  open,
  onOpenChange,
  quoteId,
  onRecorded,
  onRequested,
}: RecordDepositDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission } = usePermissions();
  const canRecord = hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  const createDeposit = useMutation(api.deposits.create);
  const requestDeposit = useMutation(api.depositRequests.request);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [method, setMethod] = useState<PaymentMethod | undefined>(undefined);
  const [methodMissing, setMethodMissing] = useState(false);
  // The key is retained across a retry of the SAME intent so a lost response
  // cannot post twice, and replaced when what is being asked for changes so an
  // edited amount is not refused as a conflicting replay.
  const commandId = useCommandIdentity();

  const form = useForm<DepositFormValues>({
    resolver: zodResolver(depositSchema as any),
    defaultValues: { amount: undefined, notes: "" },
  });

  const onSubmit = async (values: DepositFormValues) => {
    if (!activeOrgId) return;
    if (canRecord && !method) {
      setMethodMissing(true);
      return;
    }
    setIsSubmitting(true);
    try {
      if (canRecord && method) {
        const intent = `record-deposit:${quoteId}:${values.amount}:${method}:${values.notes ?? ""}`;
        const depositId = await createDeposit({
          orgId: activeOrgId,
          quoteId,
          amount: values.amount,
          method,
          notes: values.notes || undefined,
          idempotencyKey: commandId.for(intent),
        });
        toast.success(t("DepositRecordedSuccess" as any) ?? "Deposit recorded — vehicle is now on hold");
        commandId.retire(intent);
        onOpenChange(false);
        onRecorded(depositId);
      } else {
        const intent = `request-deposit:${quoteId}:${values.amount}:${values.notes ?? ""}`;
        const requestId = await requestDeposit({
          orgId: activeOrgId,
          quoteId,
          amount: values.amount,
          note: values.notes || undefined,
          idempotencyKey: commandId.for(intent),
        });
        toast.success(t("DepositRequestedSuccess" as any));
        commandId.retire(intent);
        onOpenChange(false);
        onRequested?.(requestId);
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    void form.handleSubmit(onSubmit)(event);
  };

  const title = canRecord ? t("RecordDeposit" as any) : t("RequestDeposit" as any);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {canRecord ? t("RecordDepositDesc" as any) : t("RequestDepositDesc" as any)}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={handleFormSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("DepositAmount" as any) ?? "Deposit Amount (JOD)"}</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" min="0" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {canRecord ? (
              <div className="space-y-2" data-testid="deposit-method-field">
                <span className="text-sm font-medium">{t("PaymentMethodLabel" as any)}</span>
                <PaymentMethodSelect
                  t={t as any}
                  value={method}
                  onValueChange={(next) => {
                    setMethod(next);
                    setMethodMissing(false);
                  }}
                  ariaLabel={t("PaymentMethodLabel" as any)}
                  placeholder={t("DepositChooseMethod" as any)}
                />
                {methodMissing ? (
                  <p className="text-sm font-medium text-destructive" role="alert">
                    {t("DepositMethodRequired" as any)}
                  </p>
                ) : null}
              </div>
            ) : null}

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("Notes" as any) || "Notes"}</FormLabel>
                  <FormControl>
                    <Textarea placeholder={t("Optional" as any) ?? "Optional"} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any) || "Cancel"}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (t("Saving" as any) || "Saving...") : title}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
