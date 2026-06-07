"use client";

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

// Zod schema for the form
// Note: We use string for numeric inputs in the form and convert on submit
const saleSchema = z.object({
  vehicleId: z.string().min(1, "Vehicle is required"),
  customerId: z.string().min(1, "Customer is required"),
  salespersonId: z.string().min(1, "Salesperson is required"),
  salePrice: z.coerce.number().min(0, "Sale price must be positive"),
  saleDate: z.string().min(1, "Sale date is required"),
  status: z.enum(["PENDING", "COMPLETED", "CANCELLED"]),

  // Deal Structuring
  taxRate: z.coerce.number().min(0).optional(),
  taxAmount: z.coerce.number().min(0).optional(),
  dealerFees: z.coerce.number().min(0).optional(),
  downPayment: z.coerce.number().min(0).optional(),
  tradeInVehicleId: z.string().optional(),
  tradeInValue: z.coerce.number().min(0).optional(),
  financingType: z.enum(["CASH", "FINANCED", "LEASE"]).optional(),
  loanAmount: z.coerce.number().min(0).optional(),
  apr: z.coerce.number().min(0).optional(),
  termMonths: z.coerce.number().min(0).optional(),
  warrantySold: z.coerce.number().min(0).optional(),
  gapSold: z.coerce.number().min(0).optional(),

});

type SaleFormValues = z.infer<typeof saleSchema>;

interface SaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale?: (Doc<"sales"> & { vehicle: any, customer: any, salesperson: any }) | null;
}

export function SaleDialog({ open, onOpenChange, sale }: SaleDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  // Queries for dropdowns
  const customers = useQuery(api.customers.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  // Only fetch AVAILABLE vehicles if we're creating a new sale, or include the current one if editing
  const availableVehicles = useQuery(api.vehicles.list, activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip");
  const memberships = useQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  const createSale = useMutation(api.sales.create);
  const updateSale = useMutation(api.sales.update);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<SaleFormValues>({
    resolver: zodResolver(saleSchema),
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
      gapSold: 0,
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
        gapSold: sale.gapSold || 0,
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
        gapSold: 0,
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
        await updateSale({
          orgId: activeOrgId,
          saleId: sale._id,
          salePrice: values.salePrice,
          saleDate: parsedDate,
          status: values.status,
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
          gapSold: values.gapSold,
        });
        toast.success("Sale updated successfully");
      } else {
        // Creating
        await createSale({
          orgId: activeOrgId,
          vehicleId: values.vehicleId as Id<"vehicles">,
          customerId: values.customerId as Id<"customers">,
          salespersonId: values.salespersonId as Id<"users">,
          salePrice: values.salePrice,
          saleDate: parsedDate,
          status: values.status,
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
          gapSold: values.gapSold,
        });
        toast.success(t("SaleRemovedSuccess" as any) || "Sale recorded successfully!");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to log sale");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{sale ? (t("EditSale" as any) || "Edit Sale") : (t("LogSale" as any) || "Log a Sale")}</DialogTitle>
          <DialogDescription>
            {sale
              ? (t("UpdateSaleDesc" as any) || "Update sale details. If you cancel it, the vehicle will be marked as available again.")
              : (t("AddSaleDesc" as any) || "Record a new vehicle sale. This will automatically mark the vehicle as SOLD and close related leads.")}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

            <div className="space-y-6">
              {/* Vehicle & Customer Section */}
              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">{t("VehicleAndCustomer" as any) || "Vehicle & Customer"}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {!sale && (
                    <>
                      <FormField
                        control={form.control}
                        name="vehicleId"
                        render={({ field }) => (
                          <FormItem className="md:col-span-2">
                            <FormLabel>{t("Vehicle" as any) || "Vehicle"} <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={(val) => {
                              field.onChange(val);
                              const v = availableVehicles?.find(v => v._id === val);
                              if (v && form.getValues("salePrice") === 0) {
                                form.setValue("salePrice", v.sellingPrice);
                              }
                            }} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder={t("SelectVehicle" as any) || "Select vehicle"} /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {availableVehicles?.map((v) => (
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
                        name="customerId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("Customer" as any) || "Customer"} <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder={t("SelectCustomer" as any) || "Select customer"} /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {customers?.map((c) => (
                                  <SelectItem key={c._id} value={c._id}>
                                    {c.firstName} {c.lastName}
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
                            <FormLabel>{t("Salesperson" as any) || "Salesperson"} <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder={t("SelectSalesperson" as any) || "Select salesperson"} /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
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
                    </>
                  )}
                  <FormField
                    control={form.control}
                    name="saleDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("SaleDate" as any) || "Sale Date"} <span className="text-red-500">*</span></FormLabel>
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
                        <FormLabel>{t("Status" as any) || "Status"}</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder={t("SelectStatus" as any) || "Select status"} /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="PENDING">{t("PendingStatus" as any) || "Pending (Financing/Paperwork)"}</SelectItem>
                            <SelectItem value="COMPLETED">{t("CompletedStatus" as any) || "Completed (Delivered)"}</SelectItem>
                            <SelectItem value="CANCELLED">{t("CancelledStatus" as any) || "Cancelled (Refunded/Backed out)"}</SelectItem>
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
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">{t("PricingAndFees" as any) || "Pricing & Fees"}</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="salePrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("SalePrice" as any) || "Sale Price (JOD)"} <span className="text-red-500">*</span></FormLabel>
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
                        <FormLabel>{t("Taxes" as any) || "Taxes (JOD)"}</FormLabel>
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
                        <FormLabel>{t("DealerFees" as any) || "Dealer Fees (JOD)"}</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Trade-In & Financing Section */}
              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">{t("FinancingAndTradeIn" as any) || "Financing & Trade-In"}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="tradeInVehicleId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("TradeInVehicle" as any) || "Trade-In Vehicle"}</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder={t("SelectTradeIn" as any) || "Select trade-in (optional)"} /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">{t("None" as any) || "None"}</SelectItem>
                            {availableVehicles?.map((v) => (
                              <SelectItem key={v._id} value={v._id}>
                                {v.year} {v.make} {v.model} - {v.vin}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">{t("VehicleMustBeAdded" as any) || "Vehicle must be added to inventory first."}</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="tradeInValue"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("TradeInValue" as any) || "Trade-In Allowance (JOD)"}</FormLabel>
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
                        <FormLabel>{t("DownPayment" as any) || "Down Payment (JOD)"}</FormLabel>
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
                        <FormLabel>{t("FinancingType" as any) || "Financing Type"}</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder={t("SelectType" as any) || "Select type"} /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="CASH">{t("Cash" as any) || "Cash"}</SelectItem>
                            <SelectItem value="FINANCED">{t("Financed" as any) || "Financed"}</SelectItem>
                            <SelectItem value="LEASE">{t("Lease" as any) || "Lease"}</SelectItem>
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
                        <FormLabel>{t("TotalLoanAmount" as any) || "Total Out-the-Door / Loan Amount (JOD)"}</FormLabel>
                        <FormControl><Input type="number" step="0.01" disabled {...field} className="font-bold bg-muted" /></FormControl>
                        <p className="text-xs text-muted-foreground">{t("CalculatedAutomatically" as any) || "Calculated automatically: Price + Tax + Fees + Warranty + GAP - Down Payment - Trade-In"}</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            </div>

            {watchAll.financingType === "FINANCED" && (
              <div className="bg-muted p-4 rounded-lg space-y-4">
                <h4 className="font-semibold">{t("DealStructuring" as any) || "F&I Deal Structuring"}</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="apr"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("APR" as any) || "APR (%)"}</FormLabel>
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
                        <FormLabel>{t("TermMonths" as any) || "Term (Months)"}</FormLabel>
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
                        <FormLabel>{t("Warranty" as any) || "Extended Warranty (JOD)"}</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="gapSold"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("GAPInsurance" as any) || "GAP Insurance (JOD)"}</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="mt-4 flex items-center justify-between border-t pt-4 border-primary/20">
                  <span className="font-semibold text-lg">{t("EstMonthlyPayment" as any) || "Estimated Monthly Payment"}</span>
                  <span className="font-bold text-2xl text-primary">{estimatedPayment.toFixed(2)} JOD / mo</span>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any) || "Cancel"}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (t("Saving" as any) || "Saving...") : sale ? (t("SaveChanges" as any) || "Save Changes") : (t("LogSale" as any) || "Log Sale")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
