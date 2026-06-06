"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
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
});

type SaleFormValues = z.infer<typeof saleSchema>;

interface SaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale?: (Doc<"sales"> & { vehicle: any, customer: any, salesperson: any }) | null;
}

export function SaleDialog({ open, onOpenChange, sale }: SaleDialogProps) {
  const { activeOrgId } = useOrg();
  
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
    },
  });

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
      });
    }
  }, [sale, open, form]);

  
  const salePrice = form.watch("salePrice");
  const taxAmount = form.watch("taxAmount");
  const dealerFees = form.watch("dealerFees");
  const downPayment = form.watch("downPayment");
  const tradeInValue = form.watch("tradeInValue");
  const financingType = form.watch("financingType");

  useEffect(() => {
    const total = (Number(salePrice) || 0) + (Number(taxAmount) || 0) + (Number(dealerFees) || 0) - (Number(downPayment) || 0) - (Number(tradeInValue) || 0);
    form.setValue("loanAmount", total > 0 ? total : 0);
  }, [salePrice, taxAmount, dealerFees, downPayment, tradeInValue, form]);

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
        });
        toast.success("Sale logged successfully!");
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
          <DialogTitle>{sale ? "Edit Sale" : "Log a Sale"}</DialogTitle>
          <DialogDescription>
            {sale 
              ? "Update sale details. If you cancel it, the vehicle will be marked as available again." 
              : "Record a new vehicle sale. This will automatically mark the vehicle as SOLD and close related leads."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            
            <div className="space-y-6">
              {/* Vehicle & Customer Section */}
              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Vehicle & Customer</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {!sale && (
                    <>
                      <FormField
                        control={form.control}
                        name="vehicleId"
                        render={({ field }) => (
                          <FormItem className="md:col-span-2">
                            <FormLabel>Vehicle <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={(val) => {
                              field.onChange(val);
                              const v = availableVehicles?.find(v => v._id === val);
                              if (v && form.getValues("salePrice") === 0) {
                                form.setValue("salePrice", v.sellingPrice);
                              }
                            }} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select vehicle" /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {availableVehicles?.map((v) => (
                                  <SelectItem key={v._id} value={v._id}>
                                    {v.year} {v.make} {v.model} - {v.vin} (${v.sellingPrice.toLocaleString()})
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
                            <FormLabel>Customer <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
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
                            <FormLabel>Salesperson <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select salesperson" /></SelectTrigger>
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
                        <FormLabel>Sale Date <span className="text-red-500">*</span></FormLabel>
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
                        <FormLabel>Status</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="PENDING">Pending (Financing/Paperwork)</SelectItem>
                            <SelectItem value="COMPLETED">Completed (Delivered)</SelectItem>
                            <SelectItem value="CANCELLED">Cancelled (Refunded/Backed out)</SelectItem>
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
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Pricing & Fees</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="salePrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sale Price ($) <span className="text-red-500">*</span></FormLabel>
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
                        <FormLabel>Taxes ($)</FormLabel>
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
                        <FormLabel>Dealer Fees ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Trade-In & Financing Section */}
              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Financing & Trade-In</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="tradeInVehicleId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Trade-In Vehicle</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder="Select trade-in (optional)" /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {availableVehicles?.map((v) => (
                              <SelectItem key={v._id} value={v._id}>
                                {v.year} {v.make} {v.model} - {v.vin}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">Vehicle must be added to inventory first.</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="tradeInValue"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Trade-In Allowance ($)</FormLabel>
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
                        <FormLabel>Down Payment ($)</FormLabel>
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
                        <FormLabel>Financing Type</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="CASH">Cash</SelectItem>
                            <SelectItem value="FINANCED">Financed</SelectItem>
                            <SelectItem value="LEASE">Lease</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  {financingType !== "CASH" && (
                    <>
                      <FormField
                        control={form.control}
                        name="apr"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>APR (%)</FormLabel>
                            <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="termMonths"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Term (Months)</FormLabel>
                            <FormControl><Input type="number" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </>
                  )}
                  
                  <FormField
                    control={form.control}
                    name="loanAmount"
                    render={({ field }) => (
                      <FormItem className="md:col-span-2">
                        <FormLabel>Total Out-the-Door / Loan Amount ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" disabled {...field} className="font-bold bg-muted" /></FormControl>
                        <p className="text-xs text-muted-foreground">Calculated automatically: Price + Tax + Fees - Down Payment - Trade-In</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            </div>
            
            <div className="flex justify-end gap-2 pt-4">

              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : sale ? "Save Changes" : "Log Sale"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
