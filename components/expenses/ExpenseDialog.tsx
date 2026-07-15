"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Checkbox } from "@/components/ui/checkbox";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";

import { expenseSchema, ExpenseFormValues, ExpenseDialogProps } from "./expense.schema";

export function ExpenseDialog({ open, onOpenChange, expense }: ExpenseDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const availableVehicles = useQuery(
    api.vehicles.listAll,
    activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip"
  );
  const { results: memberships } = usePaginatedQuery(
    api.memberships.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const createExpense = useMutation(api.expenses.create);
  const updateExpense = useMutation(api.expenses.update);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseSchema as any),
    defaultValues: {
      title: "",
      amount: 0,
      taxAmount: 0,
      date: new Date().toISOString().split('T')[0],
      category: "OTHER",
      vehicleId: "none",
      status: "PAID",
      vendor: "",
      payerId: "none",
      paymentMethod: "CASH",
      notes: "",
      isPrepaid: false,
      amortizationMonths: undefined,
      amortizationStartDate: "",
    },
  });
  const paymentStatus = form.watch("status");
  const isPrepaid = form.watch("isPrepaid");
  const expenseDateValue = form.watch("date");

  useEffect(() => {
    if (expense && open) {
      const date = new Date(expense.date);
      form.reset({
        title: expense.title,
        amount: expense.amount,
        taxAmount: expense.taxAmount || 0,
        date: date.toISOString().split('T')[0],
        category: expense.category as any,
        vehicleId: expense.vehicleId || "none",
        status: expense.status || "PAID",
        vendor: expense.vendor || "",
        payerId: expense.payerId || "none",
        paymentMethod: (expense.paymentMethod || "CASH") as PaymentMethod,
        notes: expense.notes || "",
        isPrepaid: expense.isPrepaid ?? false,
        amortizationMonths: expense.amortizationMonths ?? undefined,
        amortizationStartDate: expense.amortizationStartDate
          ? new Date(expense.amortizationStartDate).toISOString().split('T')[0]
          : "",
      });
    } else if (open && !expense) {
      form.reset({
        title: "",
        amount: 0,
        taxAmount: 0,
        date: new Date().toISOString().split('T')[0],
        category: "OTHER",
        vehicleId: "none",
        status: "PAID",
        vendor: "",
        payerId: "none",
        paymentMethod: "CASH",
        notes: "",
        isPrepaid: false,
        amortizationMonths: undefined,
        amortizationStartDate: "",
      });
    }
  }, [expense, open, form]);

  const onSubmit = async (values: ExpenseFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      const parsedDate = new Date(values.date).getTime();
      const parsedVehicleId = values.vehicleId === "none" ? undefined : (values.vehicleId as Id<"vehicles">);
      const parsedPayerId = values.payerId === "none" ? undefined : (values.payerId as Id<"users">);
      // null (distinct from undefined) means "explicitly cleared" — only
      // meaningful on update, where it tells the server to unset a
      // previously-stored value rather than leave it untouched.
      const parsedAmortizationStartDate: number | null | undefined = values.isPrepaid
        ? values.amortizationStartDate
          ? new Date(values.amortizationStartDate).getTime()
          : null
        : undefined;

      if (expense) {
        // The server is the authority on whether this is actually allowed:
        // convex/expenses.ts's update() rejects any paymentMethod change once
        // the expense has real accounting exposure ("Posted expenses are
        // locked..."). Gating it here too just silently dropped a
        // user-entered value instead of surfacing that error.
        await updateExpense({
          orgId: activeOrgId,
          expenseId: expense._id,
          title: values.title,
          amount: values.amount,
          taxAmount: values.taxAmount || undefined,
          date: parsedDate,
          category: values.category as any,
          vehicleId: parsedVehicleId === undefined ? null : parsedVehicleId,
          status: values.status,
          vendor: values.vendor,
          payerId: parsedPayerId === undefined ? null : parsedPayerId,
          paymentMethod: values.status === "PAID" ? values.paymentMethod : undefined,
          notes: values.notes,
          isPrepaid: values.isPrepaid ?? false,
          amortizationMonths: values.isPrepaid ? values.amortizationMonths : undefined,
          amortizationStartDate: parsedAmortizationStartDate,
        });
        toast.success(t("ExpenseUpdatedSuccess" as any));
      } else {
        await createExpense({
          orgId: activeOrgId,
          title: values.title,
          amount: values.amount,
          taxAmount: values.taxAmount || undefined,
          date: parsedDate,
          category: values.category as any,
          vehicleId: parsedVehicleId,
          status: values.status,
          vendor: values.vendor,
          payerId: parsedPayerId,
          paymentMethod: values.status === "PAID" ? values.paymentMethod : undefined,
          notes: values.notes,
          isPrepaid: values.isPrepaid ?? false,
          amortizationMonths: values.isPrepaid ? values.amortizationMonths : undefined,
          // create's schema has no concept of "clearing" a field that doesn't
          // exist yet — null only means something on update.
          amortizationStartDate: parsedAmortizationStartDate ?? undefined,
        });
        toast.success(t("ExpenseRecordedSuccess" as any));
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ExpenseSaveFail" as any));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{expense ? t("EditExpense" as any) : t("RecordExpense" as any)}</DialogTitle>
          <DialogDescription>
            {expense
              ? t("UpdateExpenseDetails" as any)
              : t("LogNewExpense" as any)}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("TitleDesc" as any)} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Brake pad replacement" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("AmountUSD" as any)} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="250" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="taxAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("VatAmount" as any)} ({t("Optional" as any)})</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Date" as any)} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Category" as any)}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectCategory" as any)} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="REPAIR">{t("Repair" as any)}</SelectItem>
                        <SelectItem value="MAINTENANCE">{t("Maintenance" as any)}</SelectItem>
                        <SelectItem value="DETAILING">{t("Detailing" as any)}</SelectItem>
                        <SelectItem value="TRANSPORT">{t("Transport" as any)}</SelectItem>
                        <SelectItem value="MARKETING">{t("Marketing" as any)}</SelectItem>
                        <SelectItem value="OFFICE">{t("Office" as any)}</SelectItem>
                        <SelectItem value="RENT">{t("Rent" as any)}</SelectItem>
                        <SelectItem value="UTILITIES">{t("Utilities" as any)}</SelectItem>
                        <SelectItem value="SALARIES">{t("Salaries" as any)}</SelectItem>
                        <SelectItem value="FEES">{t("ProfessionalFees" as any)}</SelectItem>
                        <SelectItem value="OTHER">{t("Other" as any)}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="vehicleId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("AssociatedVehicle" as any)}</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={t("SelectVehicle" as any)}
                        noneLabel={t("GeneralNoVehicle" as any)}
                        options={availableVehicles?.map((v: Doc<"vehicles">) => ({
                          value: v._id,
                          label: `${v.year} ${v.make} ${v.model}`,
                          subLabel: (v.vin ?? "").slice(-6),
                        })) ?? []}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("PaymentStatus" as any)}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectStatus" as any)} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="PAID">{t("Paid" as any)}</SelectItem>
                        <SelectItem value="PENDING">{t("Pending" as any)}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="vendor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("VendorPayee" as any)}</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Joe's Repair Shop" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {paymentStatus === "PAID" && (
                <FormField
                  control={form.control}
                  name="paymentMethod"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("PaymentMethodLabel" as any)}</FormLabel>
                      <FormControl>
                        <PaymentMethodSelect
                          t={t as any}
                          value={field.value as PaymentMethod}
                          onValueChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="payerId"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("PaidByPerson" as any)}</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={t("SelectTeamMember" as any)}
                        noneLabel={t("NotSpecified" as any)}
                        options={memberships?.map((m) => ({
                          value: m.userId,
                          label: m.userName,
                          subLabel: m.roleName || undefined,
                        })) ?? []}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {paymentStatus === "PAID" && (
                <div className="md:col-span-2 rounded-md border p-3 space-y-3">
                  <FormField
                    control={form.control}
                    name="isPrepaid"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start gap-3 space-y-0">
                        <FormControl>
                          <Checkbox
                            checked={!!field.value}
                            onCheckedChange={(checked) => {
                              const on = checked === true;
                              field.onChange(on);
                              if (!on) form.setValue("amortizationMonths", undefined);
                            }}
                          />
                        </FormControl>
                        <div className="space-y-0.5 leading-tight">
                          <FormLabel className="font-normal">{t("PrepaidExpenseLabel" as any)}</FormLabel>
                          <p className="text-xs text-muted-foreground">{t("PrepaidExpenseHint" as any)}</p>
                        </div>
                      </FormItem>
                    )}
                  />

                  {isPrepaid && (
                    <div className="flex flex-wrap gap-3">
                      <FormField
                        control={form.control}
                        name="amortizationMonths"
                        render={({ field }) => (
                          <FormItem className="max-w-[220px]">
                            <FormLabel>{t("AmortizationMonthsLabel" as any)} <span className="text-red-500">*</span></FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min="1"
                                step="1"
                                placeholder={t("AmortizationMonthsPlaceholder" as any)}
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="amortizationStartDate"
                        render={({ field }) => (
                          <FormItem className="max-w-[220px]">
                            <FormLabel>{t("AmortizationStartDateLabel" as any)}</FormLabel>
                            <FormControl>
                              <Input type="date" min={expenseDateValue || undefined} {...field} />
                            </FormControl>
                            <p className="text-xs text-muted-foreground">{t("AmortizationStartDateHint" as any)}</p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </div>
              )}

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("Notes" as any)}</FormLabel>
                    <FormControl>
                      <textarea
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        placeholder={t("AnyExtraDetails" as any)}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any)}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t("Saving" as any) : expense ? t("SaveChanges" as any) : t("RecordExpense" as any)}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
