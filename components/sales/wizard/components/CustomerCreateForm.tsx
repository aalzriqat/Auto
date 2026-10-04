"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";

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
import { getErrorMessage } from "@/lib/errors";


type Translate = (key: string) => string;

// Built per language so the validation messages follow the UI (SCRUM-628 F-11).
function buildNewCustomerSchema(t: Translate) {
  return z.object({
    firstName: z.string().min(1, t("CustomerFirstNameRequired")),
    lastName: z.string().min(1, t("CustomerLastNameRequired")),
    phone: z.string().optional(),
    nationalId: z.string().optional(),
    email: z.string().email(t("CustomerEmailInvalid")).optional().or(z.literal("")),
    address: z.string().optional(),
  });
}

export type NewCustomerValues = z.infer<ReturnType<typeof buildNewCustomerSchema>>;

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
  const { t: translate } = useLanguage();
  const t = translate as Translate;
  const newCustomerSchema = useMemo(() => buildNewCustomerSchema(t), [t]);
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

      toast.success(t("CustomerCreatedSuccess"));

      onCreated(newCustomer);
    } catch (error) {
      toast.error(getErrorMessage(error));
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
          {t("NewCustomerFormTitle")}
        </h3>

        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("Cancel")}
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
                    {t("FirstName")} <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder={t("CustomerFirstNamePlaceholder")}
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
                    {t("LastName")} <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder={t("CustomerLastNamePlaceholder")}
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
                  <FormLabel>{t("Phone")}</FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      dir="ltr"
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
                  <FormLabel>{t("NationalId")}</FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder={t("CustomerNationalIdPlaceholder")}
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
                  <FormLabel>{t("Email")}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      className="bg-background"
                      dir="ltr"
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
                  <FormLabel>{t("Address")}</FormLabel>
                  <FormControl>
                    <Input
                      className="bg-background"
                      placeholder={t("CustomerAddressPlaceholder")}
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
              {isCreating ? t("Saving") : t("CreateAndSelectCustomer")}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}