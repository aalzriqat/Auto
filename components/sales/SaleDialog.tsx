"use client";

"use client";

import { useRef, useState, useEffect } from "react";
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

import { saleSchema, SaleFormValues, SaleDialogProps } from "./sale.schema";


export function SaleDialog({ open, onOpenChange, sale }: SaleDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  // Queries for dropdowns
  const { results: customers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  // Only fetch AVAILABLE vehicles if we're creating a new sale, or include the current one if editing
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
      loanAmount: 0,
      apr: 0,
      termMonths: 0,
      warrantySold: 0,
      warrantyCost: 0,
      warrantyTermMonths: 0,
      gapSold: 0,
      gapCost: 0,
      gapTermMonths: 0,
    },
  });

  // Calculator logic
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
        downPayment: sale.downPayment || 0,
        tradeInVehicleId: sale.tradeInVehicleId || "none",
        tradeInValue: sale.tradeInValue || 0,
        financingType: sale.financingType || "CASH",
        loanAmount: sale.loanAmount || 0,
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
        loanAmount: 0,
        apr: 0,
        termMonths: 0,
        warrantySold: 0,
        warrantyCost: 0,
        warrantyTermMonths: 0,
        gapSold: 0,
        gapCost: 0,
        gapTermMonths: 0,
      });
    }
  }, [sale, open, form]);


  const salePrice = form.watch("salePrice");
  const taxAmount = form.watch("taxAmount");
  const dealerFees = form.watch("dealerFees");
  const downPayment = form.watch("downPayment");
  const tradeInValue = form.watch("tradeInValue");
  const warrantySold = form.watch("warrantySold");
  const gapSold = form.watch("gapSold");
  const financingType = form.watch("financingType");

  useEffect(() => {
    const total = (Number(salePrice) || 0) + (Number(taxAmount) || 0) + (Number(dealerFees) || 0) + (Number(warrantySold) || 0) + (Number(gapSold) || 0) - (Number(downPayment) || 0) - (Number(tradeInValue) || 0);
    form.setValue("loanAmount", total > 0 ? total : 0);
  }, [salePrice, taxAmount, dealerFees, downPayment, tradeInValue, warrantySold, gapSold, form]);

  const onSubmit = async (values: SaleFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      const parsedDate = new Date(values.saleDate).getTime();

      if (sale) {
        // Updating
        const completingDraft = sale.status === "PENDING" && values.status === "COMPLETED";
        await updateSale({
          orgId: activeOrgId,
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
          financingType: values.financingType,
          loanAmount: values.loanAmount,
          apr: values.apr,
          termMonths: values.termMonths,
          warrantySold: values.warrantySold,
          warrantyCost: values.warrantyCost,
          warrantyTermMonths: values.warrantyTermMonths,
          gapSold: values.gapSold,
          gapCost: values.gapCost,
          gapTermMonths: values.gapTermMonths,
        });
        if (completingDraft) {
          completeDraftIdempotencyKeyRef.current ??= `complete-draft-sale:${crypto.randomUUID()}`;
          await completeDraftSale({
            orgId: activeOrgId,
            saleId: sale._id,
            idempotencyKey: completeDraftIdempotencyKeyRef.current,
          });
          completeDraftIdempotencyKeyRef.current = null;
        }
        toast.success(t("SaleUpdatedSuccess" as any));
      } else {
        if (values.status === "CANCELLED") {
          toast.error("A new sale cannot be created as cancelled.");
          return;
        }
        // Creating
        createSaleIdempotencyKeyRef.current ??= `sale:${crypto.randomUUID()}`;
        const saleArgs = {
          orgId: activeOrgId,
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
          loanAmount: values.loanAmount,
          apr: values.apr,
          termMonths: values.termMonths,
          warrantySold: values.warrantySold,
          warrantyCost: values.warrantyCost,
          warrantyTermMonths: values.warrantyTermMonths,
          gapSold: values.gapSold,
          gapCost: values.gapCost,
          gapTermMonths: values.gapTermMonths,
          idempotencyKey: createSaleIdempotencyKeyRef.current,
        };
        if (values.status === "PENDING") {
          await createDraftSale({ ...saleArgs, status: "PENDING" });
        } else {
          await createSale({ ...saleArgs, status: "COMPLETED" });
        }
        createSaleIdempotencyKeyRef.current = null;
        toast.success(t("SaleRecordedSuccess" as any));
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
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

            <div className="space-y-6">
              {/* Vehicle & Customer Section */}
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
                                  subLabel: `${v.vin} · ${v.sellingPrice.toLocaleString()} JOD`,
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
                            {sale && <SelectItem value="CANCELLED">{t("CancelledStatus" as any)}</SelectItem>}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Pricing & Fees Section */}
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

              {/* Trade-In & Financing Section */}
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
                            <SelectItem value="FINANCED">{t("Financed" as any)}</SelectItem>
                            <SelectItem value="LEASE">{t("Lease" as any)}</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="loanAmount"
                    render={({ field }) => (
                      <FormItem className="md:col-span-2">
                        <FormLabel>{t("TotalLoanAmount" as any)}</FormLabel>
                        <FormControl><Input type="number" step="0.01" disabled {...field} className="font-bold bg-muted" /></FormControl>
                        <p className="text-xs text-muted-foreground">{t("CalculatedAutomatically" as any)}</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
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
                <div className="mt-4 flex items-center justify-between border-t pt-4 border-primary/20">
                  <span className="font-semibold text-lg">{t("EstMonthlyPayment" as any)}</span>
                  <span className="font-bold text-2xl text-primary">{estimatedPayment.toFixed(2)} JOD / mo</span>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any)}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (t("Saving" as any)) : sale ? (t("SaveChanges" as any)) : (t("LogSale" as any))}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
