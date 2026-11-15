"use client";

import { useRef, useState, useEffect, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { consignedTaxRefusal } from "@/lib/consignedTaxGuard";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useMoneyDisplay } from "@/hooks/useMoneyDisplay";
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

import { saleSchema, SaleFormValues, SaleDialogProps } from "./sale.schema";
import Link from "next/link";
import { getLocalizedErrorMessage } from "@/lib/errors";
import { ConsignedSettlementSection } from "./ConsignedSettlementSection";
import { ProfitApprovalNotice, useProfitApproval } from "./ProfitApprovalNotice";

export function SaleDialog({ open, onOpenChange, sale }: SaleDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const money = useMoneyDisplay();

  const { results: customers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const availableVehicles = useQuery(
    api.vehicles.listAll,
    activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip"
  );
  const { results: memberships } = usePaginatedQuery(
    api.memberships.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const createSale = useMutation(api.sales.create);
  const createDraftSale = useMutation(api.sales.createDraft);
  const completeDraftSale = useMutation(api.sales.completeDraft);
  const updateSale = useMutation(api.sales.update);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const createSaleIdempotencyKeyRef = useRef<string | null>(null);
  const completeDraftIdempotencyKeyRef = useRef<string | null>(null);

  const form = useForm<z.infer<typeof saleSchema>>({
    resolver: zodResolver(saleSchema as any),
    defaultValues: {

      vehicleId: "",
      customerId: "",
      salespersonId: "",
      salePrice: 0,
      saleDate: new Date().toISOString().split('T')[0],
      status: "COMPLETED",
      taxRate: 0,
      taxAmount: 0,
      dealerFees: 0,
      downPayment: 0,
      tradeInVehicleId: "",
      tradeInValue: 0,
      financingType: "CASH",
      apr: 0,
      termMonths: 0,
      warrantySold: 0,
      warrantyCost: 0,
      warrantyTermMonths: 0,
      gapSold: 0,
      gapCost: 0,
      gapTermMonths: 0,
      // The existing backend default for consigned sales.
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
    },
  });

  const watchAll = form.watch();
  const estimatedPayment = (() => {
    if (watchAll.financingType !== "FINANCED") return 0;

    const price = Number(watchAll.salePrice) || 0;
    const taxes = Number(watchAll.taxAmount) || 0;
    const fees = Number(watchAll.dealerFees) || 0;
    const warranty = Number(watchAll.warrantySold) || 0;
    const gap = Number(watchAll.gapSold) || 0;
    const downPayment = Number(watchAll.downPayment) || 0;
    const tradeIn = Number(watchAll.tradeInValue) || 0;

    const principal = price + taxes + fees + warranty + gap - downPayment - tradeIn;
    const apr = Number(watchAll.apr) || 0;
    const months = Number(watchAll.termMonths) || 1;

    if (principal <= 0) return 0;
    if (apr === 0) return principal / months;

    const r = (apr / 100) / 12;
    const payment = (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
    return payment;
  })();

  // The stored value (never mapped to CASH), for the reset below and for the changed-check on save.
  const initialFinancingType = sale?.financingType || "CASH";

  useEffect(() => {
    if (sale && open) {
      const date = new Date(sale.saleDate);
      form.reset({
        vehicleId: sale.vehicleId,
        customerId: sale.customerId,
        salespersonId: sale.salespersonId,
        salePrice: sale.salePrice,
        saleDate: date.toISOString().split('T')[0],
        status: sale.status,
        taxRate: sale.taxRate || 0,
        taxAmount: sale.taxAmount || 0,
        dealerFees: sale.dealerFees || 0,
        supplierSettlementRoute: sale.supplierSettlementRoute ?? "THROUGH_DEALERSHIP",
        downPayment: sale.downPayment || 0,
        tradeInVehicleId: sale.tradeInVehicleId || "none",
        tradeInValue: sale.tradeInValue || 0,
        financingType: initialFinancingType,
        apr: sale.apr || 0,
        termMonths: sale.termMonths || 0,
        warrantySold: sale.warrantySold || 0,
        warrantyCost: sale.warrantyCost || 0,
        warrantyTermMonths: sale.warrantyTermMonths || 0,
        gapSold: sale.gapSold || 0,
        gapCost: sale.gapCost || 0,
        gapTermMonths: sale.gapTermMonths || 0,
      });
    } else if (open && !sale) {
      form.reset({
        vehicleId: "",
        customerId: "",
        salespersonId: "",
        salePrice: 0,
        saleDate: new Date().toISOString().split('T')[0],
        status: "COMPLETED",
        taxRate: 0,
        taxAmount: 0,
        dealerFees: 0,
        downPayment: 0,
        tradeInVehicleId: "none",
        tradeInValue: 0,
        financingType: "CASH",
        apr: 0,
        termMonths: 0,
        warrantySold: 0,
        warrantyCost: 0,
        warrantyTermMonths: 0,
        gapSold: 0,
        gapCost: 0,
        gapTermMonths: 0,
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
      });
    }
  }, [sale, open, form, initialFinancingType]);

  // An unavailable vehicle is inconclusive. The server still owns the tax decision.
  const selectedVehicleId = sale ? sale.vehicleId : watchAll.vehicleId;
  const selectedVehicle = availableVehicles?.find(
    (v: Doc<"vehicles">) => v._id === selectedVehicleId
  );
  const taxRefusal = consignedTaxRefusal({
    isSourced: selectedVehicle ? selectedVehicle.sourceType === "SOURCED" : undefined,
    taxAmount: Number(watchAll.taxAmount),
    // Consigned tax blocks completion only. A draft cancellation posts nothing.
    status: watchAll.status === "COMPLETED" ? "COMPLETED" : "PENDING",
  });

  // SCRUM-260: profit approval gates financed completion.
  const profitApproval = useProfitApproval({
    orgId: activeOrgId,
    vehicleId: selectedVehicleId as Id<"vehicles"> | undefined,
    salePrice: Number(watchAll.salePrice) || 0,
    enabled: (watchAll.financingType ?? "CASH") !== "CASH" && (!sale || sale.status === "PENDING"),
    // SCRUM-659: a CASH sale has no profit rule but still cannot complete on a deleted car.
    livenessOnly: (watchAll.financingType ?? "CASH") === "CASH" && (!sale || sale.status === "PENDING"),
  });
  const blockedByProfit = watchAll.status === "COMPLETED" && profitApproval.blocked;
  const isCancelling = Boolean(sale && !sale.applicationId && watchAll.status === "CANCELLED");
  async function updateExistingSale(orgId: Id<"organizations">, sale: Doc<"sales">, values: SaleFormValues, parsedDate: number) {
    const completingDraft = sale.status === "PENDING" && values.status === "COMPLETED";
    await updateSale({
      orgId,
      saleId: sale._id,
      salePrice: values.salePrice,
      saleDate: parsedDate,
      status: completingDraft ? "PENDING" : values.status,
      taxRate: values.taxRate,
      taxAmount: values.taxAmount,
      dealerFees: values.dealerFees,
      downPayment: values.downPayment,
      tradeInVehicleId: values.tradeInVehicleId && values.tradeInVehicleId !== "none" ? values.tradeInVehicleId as Id<"vehicles"> : undefined,
      tradeInValue: values.tradeInValue,
      // Keep the stored LEASE type unless the operator changes it.
      ...(values.financingType !== initialFinancingType ? { financingType: values.financingType } : {}),
      apr: values.apr,
      termMonths: values.termMonths,
      warrantySold: values.warrantySold,
      warrantyCost: values.warrantyCost,
      warrantyTermMonths: values.warrantyTermMonths,
      gapSold: values.gapSold,
      gapCost: values.gapCost,
      gapTermMonths: values.gapTermMonths,
      // completeDraft uses the route stored on the draft.
      supplierSettlementRoute: values.supplierSettlementRoute,
    });
    if (completingDraft) {
      completeDraftIdempotencyKeyRef.current ??= `complete-draft-sale:${crypto.randomUUID()}`;
      await completeDraftSale({
        orgId,
        saleId: sale._id,
        idempotencyKey: completeDraftIdempotencyKeyRef.current,
      });
      completeDraftIdempotencyKeyRef.current = null;
    }
  }

  async function createNewSale(orgId: Id<"organizations">, values: SaleFormValues, parsedDate: number) {
    createSaleIdempotencyKeyRef.current ??= `sale:${crypto.randomUUID()}`;
    const saleArgs = {
      orgId,
      vehicleId: values.vehicleId as Id<"vehicles">,
      customerId: values.customerId as Id<"customers">,
      salespersonId: values.salespersonId as Id<"users">,
      salePrice: values.salePrice,
      saleDate: parsedDate,
      taxRate: values.taxRate,
      taxAmount: values.taxAmount,
      dealerFees: values.dealerFees,
      downPayment: values.downPayment,
      tradeInVehicleId: values.tradeInVehicleId && values.tradeInVehicleId !== "none" ? values.tradeInVehicleId as Id<"vehicles"> : undefined,
      tradeInValue: values.tradeInValue,
      financingType: values.financingType,
      apr: values.apr,
      termMonths: values.termMonths,
      warrantySold: values.warrantySold,
      warrantyCost: values.warrantyCost,
      warrantyTermMonths: values.warrantyTermMonths,
      gapSold: values.gapSold,
      gapCost: values.gapCost,
      gapTermMonths: values.gapTermMonths,
      // The backend ignores this for dealer-owned stock.
      supplierSettlementRoute: values.supplierSettlementRoute,
      idempotencyKey: createSaleIdempotencyKeyRef.current,
    };
    if (values.status === "PENDING") {
      await createDraftSale({ ...saleArgs, status: "PENDING" });
    } else {
      await createSale({ ...saleArgs, status: "COMPLETED" });
    }
    createSaleIdempotencyKeyRef.current = null;
  }

  async function runSubmission(action: () => Promise<unknown>, successMessage: string) {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await action();
      toast.success(t(successMessage));
      onOpenChange(false);
    } catch (error) {
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onSubmit(values: SaleFormValues) {
    if (!activeOrgId) return;
    if (values.status === "CANCELLED") {
      if (sale) await cancelSale(activeOrgId, sale._id);
      else toast.error("A new sale cannot be created as cancelled.");
      return;
    }
    const parsedDate = new Date(values.saleDate).getTime();
    if (sale) await runSubmission(() => updateExistingSale(activeOrgId, sale, values, parsedDate), "SaleUpdatedSuccess");
    else await runSubmission(() => createNewSale(activeOrgId, values, parsedDate), "SaleRecordedSuccess");
  }

  function cancelSale(orgId: Id<"organizations">, saleId: Id<"sales">) {
    return runSubmission(() => updateSale({ orgId, saleId, status: "CANCELLED" }), "SaleUpdatedSuccess");
  }
  function submitForm(event: FormEvent<HTMLFormElement>) {
    if (isCancelling && activeOrgId && sale) {
      // Legacy or unsaved financial fields must not block cancellation.
      event.preventDefault();
      void cancelSale(activeOrgId, sale._id);
      return;
    }
    void form.handleSubmit(onSubmit)(event);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{sale ? (t("EditSale" as any)) : (t("LogSale" as any))}</DialogTitle>
          <DialogDescription>
            {sale
              ? (t("UpdateSaleDesc" as any))
              : (t("AddSaleDesc" as any))}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={submitForm} noValidate={isCancelling} className="space-y-4">
            <div className="space-y-6">
              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">{t("VehicleAndCustomer" as any)}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {!sale && (
                    <>
                      <FormField
                        control={form.control}
                        name="vehicleId"
                        render={({ field }) => (
                          <FormItem className="md:col-span-2">
                            <FormLabel>{t("Vehicle" as any)} <span className="text-red-500">*</span></FormLabel>
                            <FormControl>
                              <SearchableSelect
                                value={field.value}
                                onValueChange={(val) => {
                                  field.onChange(val);
                                  const v = availableVehicles?.find((v: Doc<"vehicles">) => v._id === val);
                                  if (v && form.getValues("salePrice") === 0) {
                                    form.setValue("salePrice", v.sellingPrice);
                                  }
                                }}
                                placeholder={t("SelectVehicle" as any)}
                                options={availableVehicles?.map((v: Doc<"vehicles">) => ({
                                  value: v._id,
                                  label: `${v.year} ${v.make} ${v.model}`,
                                  subLabel: `${v.vin} · ${money.format(v.sellingPrice)}`,
                                })) ?? []}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="customerId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("Customer" as any)} <span className="text-red-500">*</span></FormLabel>
                            <FormControl>
                              <SearchableSelect
                                value={field.value}
                                onValueChange={field.onChange}
                                placeholder={t("SelectCustomer" as any)}
                                options={customers?.map((c) => ({
                                  value: c._id,
                                  label: `${c.firstName} ${c.lastName}`,
                                  subLabel: c.phone || c.email || undefined,
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
                            <FormLabel>{t("Salesperson" as any)} <span className="text-red-500">*</span></FormLabel>
                            <FormControl>
                              <SearchableSelect
                                value={field.value}
                                onValueChange={field.onChange}
                                placeholder={t("SelectSalesperson" as any)}
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
                    </>
                  )}
                  <FormField
                    control={form.control}
                    name="saleDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("SaleDate" as any)} <span className="text-red-500">*</span></FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
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
                        <FormLabel>{t("Status" as any)}</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder={t("SelectStatus" as any)} /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="PENDING">{t("PendingStatus" as any)}</SelectItem>
                            <SelectItem value="COMPLETED">{t("CompletedStatus" as any)}</SelectItem>
                            {/* SCRUM-447 D4: a financed deal is cancelled from the deal
                                screen, which resolves its cheque; the server refuses
                                the cancel here too. */}
                            {sale && (!sale.applicationId || sale.status === "CANCELLED") && (
                              <SelectItem value="CANCELLED">{t("CancelledStatus" as any)}</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                        {sale?.applicationId && sale.status !== "CANCELLED" && (
                          <p className="text-xs text-muted-foreground" data-testid="sale-cancel-from-deal">
                            {t("FcSaleCancelFromDeal" as any)}{" "}
                            <Link
                              className="inline-flex min-h-11 items-center font-medium underline underline-offset-2 sm:min-h-0"
                              href={`/${activeOrgId}/sales/${sale._id}/deal`}
                            >
                              {t("FcOpenDeal" as any)}
                            </Link>
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">{t("PricingAndFees" as any)}</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="salePrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("SalePriceJOD" as any)} <span className="text-red-500">*</span></FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="taxAmount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("Taxes" as any)}</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        {taxRefusal ? (
                          <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-500">
                            {t("ConsignedTaxUnsupported" as any)}
                          </p>
                        ) : null}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="dealerFees"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("DealerFees" as any)}</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {activeOrgId ? (
              <ConsignedSettlementSection
                orgId={activeOrgId}
                vehicleId={(sale ? sale.vehicleId : watchAll.vehicleId) as Id<"vehicles"> | undefined}
                salePrice={Number(watchAll.salePrice) || 0}
                value={watchAll.supplierSettlementRoute ?? "THROUGH_DEALERSHIP"}
                onChange={(route) => form.setValue("supplierSettlementRoute", route)}
                // Locked once the sale is completed: the journal, the payable
                // or receivable and the customer's invoice are all posted from
                // this choice, and re-routing them is a reversal, not an edit.
                disabled={sale != null && sale.status !== "PENDING"}
              />
              ) : null}

              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">{t("FinancingAndTradeIn" as any)}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="tradeInVehicleId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("TradeInVehicle" as any)}</FormLabel>
                        <FormControl>
                          <SearchableSelect
                            value={field.value}
                            onValueChange={field.onChange}
                            placeholder={t("SelectTradeIn" as any)}
                            noneLabel={t("None" as any)}
                            options={availableVehicles?.map((v: Doc<"vehicles">) => ({
                              value: v._id,
                              label: `${v.year} ${v.make} ${v.model}`,
                              subLabel: v.vin,
                            })) ?? []}
                          />
                        </FormControl>
                        <p className="text-xs text-muted-foreground">{t("VehicleMustBeAdded" as any)}</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="tradeInValue"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("TradeInValue" as any)}</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="downPayment"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("DownPayment" as any)}</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="financingType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("FinancingType" as any)}</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder={t("SelectType" as any)} /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="CASH">{t("Cash" as any)}</SelectItem>
                            {/* SCRUM-504: a financed sale exists only through the deal (its finance application),
                                so FINANCED is not offered for a sale that has none. A stored FINANCED value
                                still shows what it is, read-only. */}
                            {(field.value === "FINANCED" || !!sale?.applicationId) && (
                              <SelectItem value="FINANCED" disabled={!sale?.applicationId}>{t("Financed" as any)}</SelectItem>
                            )}
                            {/* SCRUM-495: LEASE is no longer offered. A stored LEASE sale still
                                shows what it is, as a disabled, non-selectable item. */}
                            {field.value === "LEASE" && (
                              <SelectItem value="LEASE" disabled>{t("LeaseRetired" as any)}</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <ProfitApprovalNotice approval={profitApproval} />
              </div>
            </div>

            {watchAll.financingType === "FINANCED" && (
              <div className="bg-muted p-4 rounded-lg space-y-4">
                <h4 className="font-semibold">{t("DealStructuring" as any)}</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="apr"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("APR" as any)}</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.1" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="termMonths"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("TermMonths" as any)}</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="mt-4 flex items-center justify-between border-t pt-4 border-primary/20">
                  <span className="font-semibold text-lg">{t("EstMonthlyPayment" as any)}</span>
                  <span className="font-bold text-2xl text-primary">{money.amount(estimatedPayment)} {money.label} / mo</span>
                </div>
              </div>
            )}

            {/* SCRUM-504: warranty and GAP are billed on any sale, not only a financed one, so their
                inputs do not live inside the FINANCED block (FINANCED is no longer freely selectable). */}
            <div className="bg-muted p-4 rounded-lg space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="warrantySold"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("Warranty" as any)}</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {!!Number(watchAll.warrantySold) && (
                  <>
                    <FormField
                      control={form.control}
                      name="warrantyCost"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("WarrantyCost" as any)}</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="warrantyTermMonths"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("WarrantyTermMonths" as any)}</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}
                <FormField
                  control={form.control}
                  name="gapSold"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("GAPInsurance" as any)}</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {!!Number(watchAll.gapSold) && (
                  <>
                    <FormField
                      control={form.control}
                      name="gapCost"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("GAPCost" as any)}</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="gapTermMonths"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("GAPTermMonths" as any)}</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any)}
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting || taxRefusal !== null || blockedByProfit}
              >
                {isSubmitting ? (t("Saving" as any)) : sale ? (t("SaveChanges" as any)) : (t("LogSale" as any))}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
