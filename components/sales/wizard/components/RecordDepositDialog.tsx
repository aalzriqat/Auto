"use client";

import { useRef, useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
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

const depositSchema = z.object({
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  notes: z.string().optional(),
});

type DepositFormValues = z.infer<typeof depositSchema>;

interface RecordDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: Id<"quotes">;
  onRecorded: () => void;
}

export function RecordDepositDialog({ open, onOpenChange, quoteId, onRecorded }: RecordDepositDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const createDeposit = useMutation(api.deposits.create);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  const form = useForm<DepositFormValues>({
    resolver: zodResolver(depositSchema as any),
    defaultValues: { amount: undefined, notes: "" },
  });

  const onSubmit = async (values: DepositFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      idempotencyKeyRef.current ??= `deposit:${crypto.randomUUID()}`;
      await createDeposit({
        orgId: activeOrgId,
        quoteId,
        amount: values.amount,
        notes: values.notes || undefined,
        idempotencyKey: idempotencyKeyRef.current,
      });
      toast.success(t("DepositRecordedSuccess" as any) ?? "Deposit recorded — vehicle is now on hold");
      idempotencyKeyRef.current = null;
      onOpenChange(false);
      onRecorded();
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    void form.handleSubmit(onSubmit)(event);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RecordDeposit" as any) ?? "Record Deposit"}</DialogTitle>
          <DialogDescription>
            {t("RecordDepositDesc" as any) ?? "Record the عربون the customer paid. The vehicle will show as reserved until the deal completes or the deposit is released."}
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
                {isSubmitting ? (t("Saving" as any) || "Saving...") : (t("RecordDeposit" as any) ?? "Record Deposit")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
