"use client";

import { useMemo, useState, type FormEvent } from "react";
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
import { useCurrency } from "@/hooks/useCurrency";
import { supportedCurrencyScale } from "@/convex/utils/money";
import { formatMinorAsMajor, parseMajorToMinor } from "@/lib/financeFeeTemplateForm";

type Translate = (key: string) => string;

/**
 * The major-unit number the mutations take, or null when that number cannot
 * carry exactly the minor units typed. Above about 9 trillion JOD a float has
 * no room for the fils, so "9007198254740.001" would leave as ...002; refusing
 * it here keeps a typed amount from ever reaching the server as another one.
 */
function exactMajorAmount(minor: number, scale: number): number | null {
  if (!Number.isSafeInteger(minor)) return null;
  // Back to major units through the exact decimal text, never by float division.
  const amount = Number(formatMinorAsMajor(minor, scale));
  // Compare the text the number is sent as, not float arithmetic on it:
  // "8800000000000.029" is the same number as "...03", yet ×1000 rounds back to ...029.
  const sent = parseMajorToMinor(String(amount), scale);
  return sent.ok && sent.minor === minor ? amount : null;
}

/**
 * The amount is text parsed exactly as money is parsed elsewhere (SCRUM-628
 * F-05): a `type=number` field let "60E-" and "-5" through to an English
 * message. No sign, no exponent, no more decimals than the currency carries;
 * Arabic-Indic digits are understood. The server still validates the figure.
 */
function buildDepositSchema(t: Translate, scale: number) {
  return z.object({
    amount: z.string().superRefine((raw, ctx) => {
      const parsed = parseMajorToMinor(raw, scale);
      if (!parsed.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t(parsed.problem === "EMPTY" ? "DepositAmountPositive" : "DepositAmountInvalid"),
        });
      } else if (parsed.minor <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t("DepositAmountPositive") });
      } else if (exactMajorAmount(parsed.minor, scale) === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t("DepositAmountInvalid") });
      }
    }),
    notes: z.string().optional(),
  });
}

type DepositFormValues = z.infer<ReturnType<typeof buildDepositSchema>>;

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
  const currency = useCurrency();
  const scale = supportedCurrencyScale(currency.code) ?? 3;
  const depositSchema = useMemo(() => buildDepositSchema(t as Translate, scale), [t, scale]);
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
    defaultValues: { amount: "", notes: "" },
  });

  const onSubmit = async (values: DepositFormValues) => {
    if (!activeOrgId) return;
    if (canRecord && !method) {
      setMethodMissing(true);
      return;
    }
    const parsed = parseMajorToMinor(values.amount, scale);
    if (!parsed.ok || parsed.minor <= 0) return;
    const amount = exactMajorAmount(parsed.minor, scale);
    if (amount === null) return;
    setIsSubmitting(true);
    try {
      if (canRecord && method) {
        const intent = `record-deposit:${quoteId}:${amount}:${method}:${values.notes ?? ""}`;
        const depositId = await createDeposit({
          orgId: activeOrgId,
          quoteId,
          amount,
          method,
          notes: values.notes || undefined,
          idempotencyKey: commandId.for(intent),
        });
        toast.success(t("DepositRecordedSuccess" as any) ?? "Deposit recorded — vehicle is now on hold");
        commandId.retire(intent);
        onOpenChange(false);
        onRecorded(depositId);
      } else {
        const intent = `request-deposit:${quoteId}:${amount}:${values.notes ?? ""}`;
        const requestId = await requestDeposit({
          orgId: activeOrgId,
          quoteId,
          amount,
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
                    <Input type="text" inputMode="decimal" dir="ltr" autoComplete="off" {...field} />
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
