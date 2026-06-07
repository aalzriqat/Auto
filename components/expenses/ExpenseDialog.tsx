"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "sonner";
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
// removed Textarea import

const expenseSchema = z.object({
  title: z.string().min(1, "Title is required"),
  amount: z.coerce.number().min(0, "Amount must be positive"),
  date: z.string().min(1, "Date is required"),
  category: z.enum(["REPAIR", "MAINTENANCE", "DETAILING", "TRANSPORT", "MARKETING", "OFFICE", "OTHER"]),
  vehicleId: z.string().optional(),
  status: z.enum(["PENDING", "PAID"]),
  vendor: z.string().optional(),
  payerId: z.string().optional(),
  notes: z.string().optional(),
});

type ExpenseFormValues = z.infer<typeof expenseSchema>;

interface ExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense?: Doc<"expenses"> | null;
}

export function ExpenseDialog({ open, onOpenChange, expense }: ExpenseDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const availableVehicles = useQuery(
    api.vehicles.listAll,
    activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip"
  );
  const memberships = useQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  const createExpense = useMutation(api.expenses.create);
  const updateExpense = useMutation(api.expenses.update);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseSchema as any),
    defaultValues: {
      title: "",
      amount: 0,
      date: new Date().toISOString().split('T')[0],
      category: "OTHER",
      vehicleId: "none",
      status: "PAID",
      vendor: "",
      payerId: "none",
      notes: "",
    },
  });

  useEffect(() => {
    if (expense && open) {
      const date = new Date(expense.date);
      form.reset({
        title: expense.title,
        amount: expense.amount,
        date: date.toISOString().split('T')[0],
        category: expense.category as any,
        vehicleId: expense.vehicleId || "none",
        status: expense.status || "PAID",
        vendor: expense.vendor || "",
        payerId: expense.payerId || "none",
        notes: expense.notes || "",
      });
    } else if (open && !expense) {
      form.reset({
        title: "",
        amount: 0,
        date: new Date().toISOString().split('T')[0],
        category: "OTHER",
        vehicleId: "none",
        status: "PAID",
        vendor: "",
        payerId: "none",
        notes: "",
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

      if (expense) {
        await updateExpense({
          orgId: activeOrgId,
          expenseId: expense._id,
          title: values.title,
          amount: values.amount,
          date: parsedDate,
          category: values.category as any,
          vehicleId: parsedVehicleId === undefined ? null : parsedVehicleId,
          status: values.status,
          vendor: values.vendor,
          payerId: parsedPayerId === undefined ? null : parsedPayerId,
          notes: values.notes,
        });
        toast.success("Expense updated successfully");
      } else {
        await createExpense({
          orgId: activeOrgId,
          title: values.title,
          amount: values.amount,
          date: parsedDate,
          category: values.category as any,
          vehicleId: parsedVehicleId,
          status: values.status,
          vendor: values.vendor,
          payerId: parsedPayerId,
          notes: values.notes,
        });
        toast.success("Expense recorded successfully!");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to save expense");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
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
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectVehicle" as any)} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">{t("GeneralNoVehicle" as any)}</SelectItem>
                        {availableVehicles?.map((v) => (
                          <SelectItem key={v._id} value={v._id}>
                            {v.year} {v.make} {v.model} - {v.vin.slice(-6)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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

              <FormField
                control={form.control}
                name="payerId"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("PaidByPerson" as any)}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectTeamMember" as any)} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">{t("NotSpecified" as any)}</SelectItem>
                        {memberships?.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {m.userName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

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
