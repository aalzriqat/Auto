"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";

const testDriveSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  salespersonId: z.string().min(1, "Salesperson is required"),
  demoPlateNumber: z.string().optional(),
  notes: z.string().optional(),
});

type TestDriveFormValues = z.infer<typeof testDriveSchema>;

interface TestDriveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId: Id<"vehicles">;
  testDrive?: any | null; // Pass null for new test drive
}

export function TestDriveDialog({ open, onOpenChange, vehicleId, testDrive }: TestDriveDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const { results: customers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const { results: memberships } = usePaginatedQuery(
    api.memberships.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const createTestDrive = useMutation(api.test_drives.create);
  const completeTestDrive = useMutation(api.test_drives.complete);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<z.infer<typeof testDriveSchema>>({
    resolver: zodResolver(testDriveSchema as any),
    defaultValues: {
      customerId: "",
      salespersonId: "",
      demoPlateNumber: "",
      notes: "",
    },
  });

  useEffect(() => {
    if (testDrive && open) {
      form.reset({
        customerId: testDrive.customerId,
        salespersonId: testDrive.salespersonId,
        demoPlateNumber: testDrive.demoPlateNumber || "",
        notes: testDrive.notes || "",
      });
    } else if (open && !testDrive) {
      form.reset({
        customerId: "",
        salespersonId: "",
        demoPlateNumber: "",
        notes: "",
      });
    }
  }, [testDrive, open, form]);

  const onSubmit = async (values: TestDriveFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      if (testDrive && !testDrive.endTime) {
        // Complete the test drive
        await completeTestDrive({
          orgId: activeOrgId,
          testDriveId: testDrive._id,
          endTime: Date.now(),
          notes: values.notes,
        });
        toast.success(t("TestDriveCompletedSuccess" as any));
      } else if (!testDrive) {
        // Create new
        await createTestDrive({
          orgId: activeOrgId,
          vehicleId,
          customerId: values.customerId as Id<"customers">,
          salespersonId: values.salespersonId as Id<"users">,
          startTime: Date.now(),
          demoPlateNumber: values.demoPlateNumber,
          notes: values.notes,
        });
        toast.success(t("TestDriveStartedSuccess" as any));
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{testDrive ? (t("CompleteDrive" as any)) : (t("LogTestDrive" as any))}</DialogTitle>
          <DialogDescription>
            {testDrive
              ? (t("CompleteTestDriveDesc" as any))
              : (t("LogTestDriveDesc" as any))}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="customerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("Customer" as any)}</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder={t("SelectACustomer" as any)}
                      disabled={!!testDrive}
                      options={customers?.map((c) => ({
                        value: c._id,
                        label: `${c.firstName} ${c.lastName}`,
                        subLabel: c.phone || undefined,
                      })) ?? []}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="salespersonId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("Salesperson" as any)}</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder={t("SelectSalesperson" as any)}
                      disabled={!!testDrive}
                      options={memberships?.map((m) => ({
                        value: m.userId,
                        label: m.userName || m.userEmail,
                        subLabel: m.roleName || undefined,
                      })) ?? []}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="demoPlateNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("DemoPlate" as any)}</FormLabel>
                  <FormControl>
                    <Input placeholder={t("Optional" as any)} {...field} disabled={!!testDrive} />
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
                  <FormLabel>{t("DescriptionNotes" as any)}</FormLabel>
                  <FormControl>
                    <Textarea placeholder={t("AnyIssuesReported" as any)} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any)}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (t("Saving" as any)) : testDrive ? (t("CompleteDrive" as any)) : (t("StartDrive" as any))}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
