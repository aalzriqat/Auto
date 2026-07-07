"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { dateInputToMs } from "@/components/accounting/AccountingTabShared";
import {
  registerExpectedPaymentSchema,
  type RegisterExpectedPaymentFormValues,
} from "./expectedPayment.schema";

export type ExpectedPaymentMethod = "CASH" | "INTERNAL_INSTALLMENT" | "CHEQUE" | "BANK_TRANSFER";

/** yyyy-mm-dd for today from local date parts — toISOString() is UTC and can be off by a day near midnight. */
function todayLocalInput(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type RegisterExpectedPaymentDialogProps = {
  open: boolean;
  disabled: boolean;
  submitting: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: {
    method: ExpectedPaymentMethod;
    expectedDate: number;
    chequeDetails?: { bank: string; chequeNumber: string };
  }) => void;
};

/** Registers cash/in-house-installment/cheque/bank-transfer as the expected settlement, before finalizeDeal. */
export function RegisterExpectedPaymentDialog({
  open,
  disabled,
  submitting,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<RegisterExpectedPaymentDialogProps>) {
  const form = useForm<RegisterExpectedPaymentFormValues>({
    resolver: zodResolver(registerExpectedPaymentSchema),
    defaultValues: {
      method: "BANK_TRANSFER",
      expectedDate: todayLocalInput(),
      bank: "",
      chequeNumber: "",
    },
  });

  const method = form.watch("method");

  useEffect(() => {
    if (method !== "CHEQUE") {
      form.clearErrors(["bank", "chequeNumber"]);
    }
  }, [method, form]);

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) form.reset();
  }

  function onSubmit(values: RegisterExpectedPaymentFormValues) {
    onConfirm({
      method: values.method,
      expectedDate: dateInputToMs(values.expectedDate),
      chequeDetails:
        values.method === "CHEQUE"
          ? { bank: values.bank ?? "", chequeNumber: values.chequeNumber ?? "" }
          : undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-indigo-500/40 text-indigo-600 hover:bg-indigo-500/10" disabled={disabled}>
          <Wallet className="h-4 w-4 me-2" />
          {t("RegisterExpectedPayment")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RegisterExpectedPayment")}</DialogTitle>
          <DialogDescription>{t("RegisterExpectedPaymentDesc")}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <FormField
              control={form.control}
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("PaymentMethodLabel")}</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="CASH">{t("PaymentMethodCash")}</SelectItem>
                      <SelectItem value="INTERNAL_INSTALLMENT">{t("PaymentMethodInternalInstallment")}</SelectItem>
                      <SelectItem value="CHEQUE">{t("PaymentMethodCheque")}</SelectItem>
                      <SelectItem value="BANK_TRANSFER">{t("PaymentMethodBankTransfer")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="expectedDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ExpectedPaymentDateLabel")}</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {method === "CHEQUE" && (
              <>
                <FormField
                  control={form.control}
                  name="bank"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("Bank")}</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="chequeNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("ChequeNumber")}</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("Confirm")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
