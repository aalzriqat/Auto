"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";

import { toast } from "@/components/ui/sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

import { UserPlus } from "lucide-react";
import { PaymentType } from "../types";
import { cn } from "@/lib/utils";


const newCustomerSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  phone: z.string().optional(),
  nationalId: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  address: z.string().optional(),
});

export type NewCustomerValues = z.infer<typeof newCustomerSchema>;

// ─── Props ─────────────────────────────────────────────

interface CustomerCreateFormProps {
  paymentType: PaymentType;
  onCancel: () => void;
  onCreated: (customer: Doc<"customers">) => void;
}

// ─── Component ─────────────────────────────────────────

export function CustomerCreateForm({
  paymentType,
  onCancel,
  onCreated,
}: CustomerCreateFormProps) {
  const { activeOrgId } = useOrg();
  const createCustomer = useMutation(api.customers.create);
  const [isCreating, setIsCreating] = useState(false);

  const isCash = paymentType === "CASH";

  const form = useForm<NewCustomerValues>({
    resolver: zodResolver(newCustomerSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      phone: "",
      nationalId: "",
      email: "",
      address: "",
    },
  });

  const accentBtn = isCash
    ? "bg-teal-600 hover:bg-teal-700"
    : "bg-indigo-600 hover:bg-indigo-700";

  const onSubmit = async (values: NewCustomerValues) => {
    if (!activeOrgId) return;

    setIsCreating(true);

    try {
      const id = await createCustomer({
        orgId: activeOrgId,
        firstName: values.firstName,
        lastName: values.lastName,
        phone: values.phone || undefined,
        nationalId: values.nationalId || undefined,
        email: values.email || undefined,
        address: values.address || undefined,
      });

      const newCustomer: Doc<"customers"> = {
        _id: id as Id<"customers">,
        _creationTime: Date.now(),
        orgId: activeOrgId as Id<"organizations">,
        firstName: values.firstName,
        lastName: values.lastName,
        phone: values.phone || undefined,
        nationalId: values.nationalId || undefined,
        email: values.email || undefined,
        address: values.address || undefined,
      };

      toast.success("Customer created successfully");

      onCreated(newCustomer);
    } catch (error: any) {
      toast.error(error.message || "Failed to create customer");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2">
          <UserPlus className="w-4 h-4" />
          New Customer
        </h3>

        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {/* Form */}
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    First Name <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder="Ahmad"
                      {...field}
                    />
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
                  <FormLabel>
                    Last Name <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder="Al-Rashid"
                      {...field}
                    />
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
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder="+962 7X XXX XXXX"
                      {...field}
                    />
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
                  <FormLabel>National ID</FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder="ID Number"
                      {...field}
                    />
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
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      className="bg-background"
                      placeholder="customer@example.com"
                      {...field}
                    />
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
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder="City, Country"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Submit */}
          <div className="flex justify-end pt-2">
            <Button
              type="submit"
              disabled={isCreating}
              className={accentBtn}
            >
              {isCreating ? "Creating..." : "Create & Select"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}