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

import { leadSchema, LeadFormValues, LeadDialogProps } from "./lead.schema";


export function LeadDialog({ open, onOpenChange, lead }: LeadDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  // Data for dropdowns
  const { results: customers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const vehicles = useQuery(api.vehicles.listAll, activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip");
  const dynamicLeadSources = useQuery(
    api.orgLeadSources.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const { results: memberships } = usePaginatedQuery(
    api.memberships.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const createLead = useMutation(api.leads.create);
  const updateLead = useMutation(api.leads.update);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<LeadFormValues>({
    resolver: zodResolver(leadSchema as any),
    defaultValues: {
      customerId: "",
      vehicleId: "",
      assignedUserId: "",
      source: "Walk-in",
      stage: "NEW",
      notes: "",
    },
  });

  useEffect(() => {
    if (lead && open) {
      form.reset({
        customerId: lead.customerId,
        vehicleId: lead.vehicleId || "",
        assignedUserId: lead.assignedUserId || "",
        source: lead.source,
        stage: lead.stage,
        notes: lead.notes || "",
      });
    } else if (open && !lead) {
      form.reset({
        customerId: "",
        vehicleId: "",
        assignedUserId: "",
        source: "Walk-in",
        stage: "NEW",
        notes: "",
      });
    }
  }, [lead, open, form]);

  const onSubmit = async (values: LeadFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      const payload = {
        customerId: values.customerId as Id<"customers">,
        vehicleId: values.vehicleId && values.vehicleId !== "none" ? values.vehicleId as Id<"vehicles"> : undefined,
        assignedUserId: values.assignedUserId && values.assignedUserId !== "none" ? values.assignedUserId as Id<"users"> : undefined,
        source: values.source,
        stage: values.stage as any,
        notes: values.notes || undefined,
      };

      if (lead) {
        await updateLead({
          orgId: activeOrgId,
          leadId: lead._id,
          ...payload,
        });
        toast.success(t("LeadUpdatedSuccess" as any) || "Lead updated successfully");
      } else {
        await createLead({
          orgId: activeOrgId,
          ...payload,
        });
        toast.success(t("LeadAddedSuccess" as any) || "Lead created successfully");
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
          <DialogTitle>{lead ? (t("EditLead" as any) || "Edit Lead") : (t("AddLead" as any) || "Create Lead")}</DialogTitle>
          <DialogDescription>
            {lead ? (t("UpdateLeadDesc" as any) || "Update the lead's details and stage.") : (t("AddLeadDesc" as any) || "Create a new sales lead.")}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("Customer" as any) || "Customer"} <span className="text-red-500">*</span></FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectCustomer" as any) || "Select a customer"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {customers?.map((c) => (
                          <SelectItem key={c._id} value={c._id}>
                            {c.firstName} {c.lastName} {c.email ? `(${c.email})` : ""}
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
                name="vehicleId"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("VehicleOfInterest" as any) || "Vehicle of Interest (Optional)"}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectVehicle" as any) || "Select a vehicle"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">{t("NoSpecificVehicle" as any) || "No specific vehicle yet"}</SelectItem>
                        {vehicles?.map((v) => (
                          <SelectItem key={v._id} value={v._id}>
                            {v.year} {v.make} {v.model} - {v.vin} ({v.sellingPrice.toLocaleString()} JOD)
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
                name="assignedUserId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("AssignedTo" as any) || "Assigned Salesperson"}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("NoAssigned" as any) || "Unassigned"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">{t("NoAssigned" as any) || "Unassigned"}</SelectItem>
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
                name="stage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Stage" as any) || "Stage"}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("Stage" as any) || "Select stage"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="NEW">{t("StageNew" as any) || "New"}</SelectItem>
                        <SelectItem value="CONTACTED">{t("StageContacted" as any) || "Contacted"}</SelectItem>
                        <SelectItem value="INTERESTED">{t("Interested" as any) || "Interested"}</SelectItem>
                        <SelectItem value="TEST_DRIVE">{t("StageTestDrive" as any) || "Test Drive"}</SelectItem>
                        <SelectItem value="NEGOTIATION">{t("StageNegotiation" as any) || "Negotiation"}</SelectItem>
                        <SelectItem value="RESERVED">{t("Reserved" as any) || "Reserved"}</SelectItem>
                        <SelectItem value="WON">{t("StageWon" as any) || "Won"}</SelectItem>
                        <SelectItem value="LOST">{t("Lost" as any) || "Lost"}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="source"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("LeadSource" as any) || "Source"}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectSource" as any) || "Select lead source"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(dynamicLeadSources && dynamicLeadSources.length > 0
                          ? dynamicLeadSources.filter((s) => s.isActive)
                          : [
                              { label: "Walk-in" },
                              { label: "Website" },
                              { label: "Facebook" },
                              { label: "Instagram" },
                              { label: "Referral" },
                              { label: "Phone" },
                              { label: "Other" },
                            ]
                        ).map((s) => (
                          <SelectItem key={s.label} value={s.label}>
                            {s.label}
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
                    <FormLabel>{t("Notes" as any) || "Notes"}</FormLabel>
                    <FormControl>
                      <Input placeholder={t("NotesPlaceholder" as any) || "Customer preferences, budget, etc."} {...field} />
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
                {isSubmitting ? (t("Saving" as any) || "Saving...") : lead ? (t("SaveChanges" as any) || "Save Changes") : (t("AddLead" as any) || "Create Lead")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
