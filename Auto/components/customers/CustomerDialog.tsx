"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
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

import { customerSchema, CustomerFormValues, CustomerDialogProps } from "./customer.schema";


export function CustomerDialog({ open, onOpenChange, customer }: CustomerDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const createCustomer = useMutation(api.customers.create);
  const updateCustomer = useMutation(api.customers.update);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema as any),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      whatsapp: "",
      nationalId: "",
      address: "",
    },
  });

  useEffect(() => {
    if (customer && open) {
      form.reset({
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email || "",
        phone: customer.phone || "",
        whatsapp: customer.whatsapp || "",
        nationalId: customer.nationalId || "",
        address: customer.address || "",
      });
    } else if (open && !customer) {
      form.reset({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        whatsapp: "",
        nationalId: "",
        address: "",
      });
    }
  }, [customer, open, form]);

  const onSubmit = async (values: CustomerFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      // Normalize empty strings to undefined
      const payload = {
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email || undefined,
        phone: values.phone || undefined,
        whatsapp: values.whatsapp || undefined,
        nationalId: values.nationalId || undefined,
        address: values.address || undefined,
      };

      if (customer) {
        await updateCustomer({
          orgId: activeOrgId,
          customerId: customer._id,
          ...payload,
        });
        toast.success(t("CustomerUpdatedSuccess" as any) || "Customer updated successfully");
      } else {
        await createCustomer({
          orgId: activeOrgId,
          ...payload,
        });
        toast.success(t("CustomerAddedSuccess" as any) || "Customer added successfully");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{customer ? (t("EditCustomer" as any) || "Edit Customer") : (t("AddCustomer" as any) || "Add Customer")}</DialogTitle>
          <DialogDescription>
            {customer ? (t("UpdateCustomerDesc" as any) || "Update customer details below.") : (t("AddCustomerDesc" as any) || "Enter the details of the new customer.")}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("FirstName" as any) || "First Name"} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <Input placeholder="John" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("LastName" as any) || "Last Name"} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <Input placeholder="Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("Email" as any) || "Email"}</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="john.doe@example.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Phone" as any) || "Phone"}</FormLabel>
                    <FormControl>
                      <Input placeholder="+1 234 567 8900" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="whatsapp"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("WhatsApp" as any) || "WhatsApp"}</FormLabel>
                    <FormControl>
                      <Input placeholder="+1 234 567 8900" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="nationalId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("NationalIDPassport" as any) || "National ID / Passport"}</FormLabel>
                    <FormControl>
                      <Input placeholder="ID Number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("Address" as any) || "Address"}</FormLabel>
                    <FormControl>
                      <Input placeholder="123 Main St, City, Country" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any) || "Cancel"}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (t("Saving" as any) || "Saving...") : customer ? (t("SaveChanges" as any) || "Save Changes") : (t("AddCustomer" as any) || "Add Customer")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
