"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
import { SearchableSelect, SearchableSelectOption } from "@/components/ui/searchable-select";

import { leadSchema, LeadFormValues, LeadDialogProps } from "./lead.schema";
import { CustomFieldsSection, useSaveCustomFieldValues } from "@/components/custom-fields/CustomFieldsSection";
import { LeadActivityTrail } from "./LeadActivityTrail";
import { LeadCustomerMessages } from "./LeadCustomerMessages";
import { translateLeadSourceLabel, translatePipelineStageLabel } from "@/lib/i18n/defaultLabels";

/**
 * Pins a lead's stored value into a dropdown's option list when it isn't
 * already there.
 *
 * A lead's value legitimately falls outside these lists all the time: the
 * social and marketplace automations write sources like "Facebook DM" that
 * nobody configured under Settings, the customer or salesperson may sit past
 * the 100-row page these dropdowns load, and a lead can point at a vehicle
 * that has since been sold (the vehicle query only asks for AVAILABLE).
 * Both Select implementations resolve their display label by looking the
 * value up in `options` and fall back to the placeholder on a miss — so an
 * unpinned value renders as "Select customer" on a lead that plainly has one.
 */
function withCurrentOption(
  options: SearchableSelectOption[],
  current: SearchableSelectOption | null
): SearchableSelectOption[] {
  if (!current?.value || current.value === "none") return options;
  if (options.some((o) => o.value === current.value)) return options;
  return [current, ...options];
}

export function LeadDialog({ open, onOpenChange, lead }: LeadDialogProps) {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const router = useRouter();
  const [customerSearch, setCustomerSearch] = useState("");

  // Data for dropdowns
  const customerSelectorOptions = useQuery(
    api.customers.selectorOptions,
    activeOrgId ? { orgId: activeOrgId, search: customerSearch } : "skip"
  );
  const vehicles = useQuery(api.vehicles.listAll, activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE", includeReserved: true } : "skip");
  const dynamicLeadSources = useQuery(
    api.orgLeadSources.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const pipelineStages = useQuery(
    api.orgPipelineStages.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const { results: memberships } = usePaginatedQuery(
    api.memberships.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const vehicleOptions = useMemo(
    () =>
      withCurrentOption(
        vehicles?.map((v: Doc<"vehicles">) => ({
          value: v._id as string,
          label: `${v.year} ${v.make} ${v.model}`,
          subLabel: `${v.vin} · ${v.sellingPrice.toLocaleString()} JOD${v.status === "RESERVED" ? " · Reserved (pending deal)" : ""}`,
        })) ?? [],
        lead?.vehicleId
          ? {
              value: lead.vehicleId as string,
              label:
                lead.vehicleSummary ||
                (lead.vehicle ? `${lead.vehicle.year} ${lead.vehicle.make} ${lead.vehicle.model}` : "") ||
                (t("Unknown" as any) || "Unknown vehicle"),
            }
          : null
      ),
    [vehicles, lead, t]
  );

  const assigneeOptions = useMemo(
    () =>
      withCurrentOption(
        memberships?.map((m) => ({
          value: m.userId as string,
          label: m.userName,
          subLabel: m.roleName || undefined,
        })) ?? [],
        lead?.assignedUserId
          ? {
              value: lead.assignedUserId as string,
              label:
                lead.assignedUserName ||
                lead.assignedUser?.name ||
                lead.assignedUser?.email ||
                (t("Unknown" as any) || "Unknown user"),
            }
          : null
      ),
    [memberships, lead, t]
  );

  // Source is a free-text column, not an FK, so the same pinning applies to its
  // raw string: an automation-written "Facebook DM" is a valid source that no
  // org has in its configured list.
  const sourceOptions = useMemo(() => {
    const configured =
      dynamicLeadSources && dynamicLeadSources.length > 0
        ? dynamicLeadSources
            .filter((s: Doc<"orgLeadSources">) => s.isActive)
            .map((s: Doc<"orgLeadSources">) => s.label)
        : ["Walk-in", "Website", "Facebook", "Instagram", "Referral", "Phone", "Other"];

    return lead?.source && !configured.includes(lead.source)
      ? [lead.source, ...configured]
      : configured;
  }, [dynamicLeadSources, lead]);

  const createLead = useMutation(api.leads.create);
  const updateLead = useMutation(api.leads.update);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});
  const saveCustomFields = useSaveCustomFieldValues();
  // `customers.selectorOptions` searches server-side but still returns a
  // capped window, so a lead's own customer can fall outside it — pin it in.
  const customerOptions = useMemo(
    () =>
      withCurrentOption(
        customerSelectorOptions?.map((customer) => ({
          value: customer._id as string,
          label: `${customer.firstName} ${customer.lastName}`,
          subLabel: customer.phone || customer.email || undefined,
        })) ?? [],
        lead
          ? {
              value: lead.customerId as string,
              label:
                lead.customerName ||
                (lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}` : "") ||
                (t("Unknown" as any) || "Unknown customer"),
              subLabel:
                lead.phone || lead.customer?.phone || lead.email || lead.customer?.email || undefined,
            }
          : null
      ),
    [customerSelectorOptions, lead, t],
  );

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

  // Non-blocking nudge: warn if this customer already has an open lead
  // (optionally for the same vehicle) before the user creates a duplicate.
  const watchedCustomerId = form.watch("customerId");
  const watchedVehicleId = form.watch("vehicleId");
  const existingOpenLead = useQuery(
    api.leads.checkExistingOpenLead,
    activeOrgId && open && watchedCustomerId
      ? {
          orgId: activeOrgId,
          customerId: watchedCustomerId as Id<"customers">,
          vehicleId: watchedVehicleId && watchedVehicleId !== "none" ? (watchedVehicleId as Id<"vehicles">) : undefined,
          excludeLeadId: lead?._id,
        }
      : "skip"
  );

  // For a WON lead, surface the sale that closed it instead of just a static badge.
  const linkedSale = useQuery(
    api.leads.getLinkedSale,
    activeOrgId && lead && lead.stage === "WON" ? { orgId: activeOrgId, leadId: lead._id } : "skip"
  );

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
        await saveCustomFields(activeOrgId, "lead", lead._id, customFieldValues);
        toast.success(t("LeadUpdatedSuccess" as any) || "Lead updated successfully");
      } else {
        const newId = await createLead({
          orgId: activeOrgId,
          ...payload,
        });
        if (newId) await saveCustomFields(activeOrgId, "lead", newId, customFieldValues);
        toast.success(t("LeadAddedSuccess" as any) || "Lead created successfully");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateQuote = () => {
    if (!activeOrgId || !lead || !lead.vehicleId) return;
    router.push(
      `/${activeOrgId}/sales?leadId=${lead._id}&customerId=${lead.customerId}&vehicleId=${lead.vehicleId}`
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{lead ? (t("EditLead" as any) || "Edit Lead") : (t("AddLead" as any) || "Create Lead")}</DialogTitle>
          <DialogDescription>
            {lead ? (t("UpdateLeadDesc" as any) || "Update the lead's details and stage.") : (t("AddLeadDesc" as any) || "Create a new sales lead.")}
          </DialogDescription>
        </DialogHeader>

        {/* Shown above the form deliberately: on a social lead the first thing
            a rep needs is what the customer actually asked, not the fields. */}
        {activeOrgId && lead && (
          <LeadCustomerMessages orgId={activeOrgId} leadId={lead._id} />
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("Customer" as any) || "Customer"} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        onSearchChange={setCustomerSearch}
                        placeholder={t("SelectCustomer" as any) || "Select a customer"}
                        options={customerOptions}
                      />
                    </FormControl>
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
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={t("SelectVehicle" as any) || "Select a vehicle"}
                        noneLabel={t("NoSpecificVehicle" as any) || "No specific vehicle yet"}
                        options={vehicleOptions}
                      />
                    </FormControl>
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
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={t("NoAssigned" as any) || "Unassigned"}
                        noneLabel={t("NoAssigned" as any) || "Unassigned"}
                        options={assigneeOptions}
                      />
                    </FormControl>
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
                        {(pipelineStages && pipelineStages.length > 0
                          ? pipelineStages.filter((s: Doc<"orgPipelineStages">) => s.isActive)
                          : [
                              { stageKey: "NEW", label: "New" },
                              { stageKey: "CONTACTED", label: "Contacted" },
                              { stageKey: "INTERESTED", label: "Interested" },
                              { stageKey: "TEST_DRIVE", label: "Test Drive" },
                              { stageKey: "NEGOTIATION", label: "Negotiation" },
                              { stageKey: "RESERVED", label: "Reserved" },
                              { stageKey: "WON", label: "Won" },
                              { stageKey: "LOST", label: "Lost" },
                            ]
                        ).map((s: { stageKey: string; label: string }) => (
                          <SelectItem key={s.stageKey} value={s.stageKey}>
                            {translatePipelineStageLabel(s.label, locale)}
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
                name="source"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("LeadSource" as any) || "Source"}</FormLabel>
                    {/*
                      `|| undefined` is load-bearing. Radix shows the placeholder
                      only when `value` is undefined; an empty string is treated
                      as a set value with no matching item, so the trigger renders
                      *neither* the value nor the placeholder — a blank box.

                      Source is free text written by automations, not an FK, so a
                      lead can carry "" (or no source at all) even though the form
                      schema requires one. sourceOptions above already pins an
                      unrecognised non-empty source; this covers the empty case.
                    */}
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value || undefined}
                      value={field.value || undefined}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectSource" as any) || "Select lead source"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {sourceOptions.map((label: string) => (
                          <SelectItem key={label} value={label}>
                            {translateLeadSourceLabel(label, locale)}
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
            {activeOrgId && (
              <CustomFieldsSection
                orgId={activeOrgId}
                entityType="lead"
                entityId={lead?._id}
                onChange={setCustomFieldValues}
              />
            )}
            {existingOpenLead && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {t("ExistingOpenLeadWarning" as any) || "This customer already has an open lead in the pipeline."}
              </div>
            )}
            {lead?.stage === "WON" && linkedSale && (
              <div className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
                {t("ConvertedToSale" as any) || "Converted to Sale"} — {linkedSale.salePrice.toLocaleString()} JOD{" "}
                {t("OnDate" as any) || "on"} {new Date(linkedSale.saleDate).toLocaleDateString(locale === "ar" ? "ar" : "en-US")}
              </div>
            )}
            {activeOrgId && lead && (
              <div className="border-t pt-4">
                <h4 className="text-sm font-medium mb-3">
                  {t("ActivityTrail" as any) || "Activity Trail"}
                </h4>
                <LeadActivityTrail
                  orgId={activeOrgId}
                  leadId={lead._id}
                  canAddUpdates={!lead.isDeleted}
                />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-4">
              {lead && lead.vehicleId && (
                <Button type="button" variant="outline" onClick={handleCreateQuote} className="me-auto">
                  {t("CreateQuote" as any) || "Create Quote"}
                </Button>
              )}
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
