"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
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
  
  const customers = useQuery(api.customers.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const memberships = useQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  const createTestDrive = useMutation(api.test_drives.create);
  const completeTestDrive = useMutation(api.test_drives.complete);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<TestDriveFormValues>({
    resolver: zodResolver(testDriveSchema),
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
        toast.success("Test drive completed successfully");
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
        toast.success("Test drive started successfully!");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to save test drive");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{testDrive ? "Complete Test Drive" : "Log Test Drive"}</DialogTitle>
          <DialogDescription>
            {testDrive 
              ? "Mark this test drive as completed." 
              : "Record a new test drive for this vehicle."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="customerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Customer</FormLabel>
                  <Select 
                    onValueChange={field.onChange} 
                    value={field.value}
                    disabled={!!testDrive}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a customer" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {customers?.map((customer) => (
                        <SelectItem key={customer._id} value={customer._id}>
                          {customer.firstName} {customer.lastName}
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
              name="salespersonId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Salesperson</FormLabel>
                  <Select 
                    onValueChange={field.onChange} 
                    value={field.value}
                    disabled={!!testDrive}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select salesperson" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {memberships?.map((membership) => (
                        <SelectItem key={membership.userId} value={membership.userId}>
                          {membership.userName || membership.userEmail}
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
              name="demoPlateNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Demo Plate Number</FormLabel>
                  <FormControl>
                    <Input placeholder="Optional" {...field} disabled={!!testDrive} />
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
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Any issues reported during the drive?" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : testDrive ? "Complete Drive" : "Start Drive"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
