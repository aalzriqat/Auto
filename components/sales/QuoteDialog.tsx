"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { calculateUnifiedMurabaha } from "@/lib/financing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2 } from "lucide-react";

const quoteSchema = z.object({
  vehicleId: z.string().min(1, "Vehicle is required"),
  customerId: z.string().min(1, "Customer is required"),
  vehiclePrice: z.coerce.number().min(0, "Price must be positive"),
  downPayment: z.coerce.number().min(0, "Down payment must be positive"),
  termMonths: z.coerce.number().min(0),
});

type QuoteFormValues = z.infer<typeof quoteSchema>;

interface QuoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultVehicleId?: string;
  defaultCustomerId?: string;
}

export function QuoteDialog({ open, onOpenChange, defaultVehicleId, defaultCustomerId }: QuoteDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  
  const customers = useQuery(api.customers.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const availableVehicles = useQuery(api.vehicles.list, activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip");
  const financeCompanies = useQuery(api.finance.listCompanies, activeOrgId ? { orgId: activeOrgId } : "skip");
  const documentRules = useQuery(api.documents.listRules, activeOrgId ? { orgId: activeOrgId } : "skip");

  const saveQuote = useMutation(api.quotes.saveQuote);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<z.infer<typeof quoteSchema>>({
    resolver: zodResolver(quoteSchema as any),
    defaultValues: {
      vehicleId: defaultVehicleId || "",
      customerId: defaultCustomerId || "",
      vehiclePrice: 0,
      downPayment: 0,
      termMonths: 84,
    },
  });

  const watchAll = form.watch();

  const valuations = useQuery(
    api.finance.listValuations, 
    activeOrgId && watchAll.vehicleId ? { orgId: activeOrgId, vehicleId: watchAll.vehicleId as Id<"vehicles"> } : "skip"
  );

  const [comparisons, setComparisons] = useState<any[]>([]);

  useEffect(() => {
    if (!financeCompanies) return;

    const principal = watchAll.vehiclePrice - watchAll.downPayment;
    const results = [];

    // 1. Cash Deal Option
    results.push({
      companyId: "cash",
      companyName: t("Cash Deal" as any) || "Cash Deal",
      isCash: true,
      totalFinancedAmount: principal,
      monthlyInstallment: 0,
      profitRateApplied: 0,
      totalProfit: 0,
      requiredValuation: 0,
      takafulAmount: 0,
    });

    // 2. Active Finance Companies
    const activeCompanies = financeCompanies.filter(c => c.isActive);
    for (const company of activeCompanies) {
      
      const executionFees = company.adminFees || 0;
      const commission = company.commission || 0;

      const result = calculateUnifiedMurabaha({
        vehiclePrice: watchAll.vehiclePrice,
        downPayment: watchAll.downPayment,
        commission: commission,
        processingFees: executionFees,
        annualProfitRate: company.profitRate,
        annualInsuranceRate: company.insuranceRate || 0,
        termMonths: watchAll.termMonths,
        gracePeriodMonths: company.gracePeriodMonths,
        includesCommissionInDebt: company.includesCommissionInDebt,
      });

      const actualValuation = valuations?.find(v => v.companyId === company._id)?.valuationAmount || 0;
      const maxLTV = company.maxFinancingLTV || 0;
      
      const maxFinancingAllowed = maxLTV > 0 && actualValuation > 0
        ? actualValuation * (maxLTV / 100)
        : Number.MAX_SAFE_INTEGER; // If no LTV/Valuation set, allow any amount
        
      const exceedsValuation = result.financedAmount > maxFinancingAllowed && actualValuation > 0;
      const minimumDownPayment = watchAll.vehiclePrice - maxFinancingAllowed;

      const requiredValuation = maxLTV > 0
        ? result.financedAmount / (maxLTV / 100) 
        : 0;
        
      const companyRules = documentRules?.filter(r => r.companyId === company._id || !r.companyId) || [];

      results.push({
        companyId: company._id,
        companyName: company.name,
        isCash: false,
        totalFinancedAmount: result.financedAmount,
        monthlyInstallment: result.monthlyInstallment,
        profitRateApplied: company.profitRate,
        totalProfit: result.totalProfit,
        requiredValuation,
        takafulAmount: result.takafulAmount,
        actualValuation,
        maxFinancingAllowed,
        exceedsValuation,
        minimumDownPayment,
        companyRules,
      });
    }

    setComparisons(results);
  }, [watchAll.vehiclePrice, watchAll.downPayment, watchAll.termMonths, financeCompanies, valuations, documentRules]);

  const onSelectQuote = async (companyResult: any) => {
    const isValid = await form.trigger(["vehicleId", "customerId"]);
    if (!isValid) return;
    
    if (companyResult.exceedsValuation) {
      toast.error(t("ExceedsFinancingLimit" as any) || "Financed amount exceeds the bank's valuation limit. Please increase the down payment.");
      return;
    }

    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      const values = form.getValues();
      await saveQuote({
        orgId: activeOrgId,
        vehicleId: values.vehicleId as Id<"vehicles">,
        customerId: values.customerId as Id<"customers">,
        companyId: companyResult.isCash ? undefined : (companyResult.companyId as Id<"financeCompanies">),
        vehiclePrice: Number(values.vehiclePrice),
        downPayment: Number(values.downPayment),
        termMonths: Number(values.termMonths),
        totalFinancedAmount: companyResult.totalFinancedAmount,
        monthlyInstallment: companyResult.monthlyInstallment,
        profitRateApplied: companyResult.profitRateApplied,
        totalProfit: companyResult.totalProfit,
      });
      toast.success("Quote generated and saved!");
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to save quote");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Smart Quote Comparison" as any) || "Smart Quote Comparison"}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form className="space-y-4">
            <div className="bg-muted p-4 rounded-lg grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="vehicleId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Vehicle" as any) || "Vehicle"} <span className="text-red-500">*</span></FormLabel>
                    <Select onValueChange={(val) => {
                      field.onChange(val);
                      const v = availableVehicles?.find(v => v._id === val);
                      if (v) form.setValue("vehiclePrice", v.sellingPrice);
                    }} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="bg-background"><SelectValue placeholder="Select vehicle" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {availableVehicles?.map((v) => (
                          <SelectItem key={v._id} value={v._id}>
                            {v.year} {v.make} {v.model} ({v.sellingPrice.toLocaleString()} JOD)
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
                        <SelectTrigger className="bg-background"><SelectValue placeholder="Select customer" /></SelectTrigger>
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
                name="termMonths"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Term (Months)" as any) || "Term (Months)"}</FormLabel>
                    <FormControl><Input type="number" className="bg-background" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="vehiclePrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Vehicle Price" as any) || "Vehicle Price (JOD)"}</FormLabel>
                    <FormControl><Input type="number" step="0.01" className="bg-background" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="downPayment"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Down Payment" as any) || "Down Payment (JOD)"}</FormLabel>
                    <FormControl><Input type="number" step="0.01" className="bg-background" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-4">
              {comparisons.map((result) => (
                <Card key={result.companyId} className={`relative flex flex-col ${result.isCash ? 'border-primary/50' : ''} ${result.exceedsValuation ? 'border-red-500/50' : ''}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg flex justify-between items-center">
                      {result.companyName}
                      {result.isCash && <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">{t("Cash" as any) || "Cash"}</span>}
                      {!result.isCash && <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">{result.profitRateApplied}% {t("Rate" as any) || "Rate"}</span>}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col justify-between">
                    <div className="space-y-2 mb-4">
                      {result.isCash ? (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{t("Total to Pay" as any)}:</span>
                          <span className="font-semibold">{result.totalFinancedAmount.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</span>
                        </div>
                      ) : (
                        <>
                          <div className="flex justify-between text-sm border-b pb-1">
                            <span className="text-muted-foreground">{t("Financed Amount" as any)}:</span>
                            <span className="font-medium">{result.totalFinancedAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
                          </div>
                          <div className="flex justify-between text-sm border-b pb-1">
                            <span className="text-muted-foreground">{t("Total Profit" as any)}:</span>
                            <span className="font-medium">{result.totalProfit.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
                          </div>
                          {result.takafulAmount > 0 && (
                            <div className="flex justify-between text-sm border-b pb-1">
                              <span className="text-muted-foreground">{t("Takaful" as any)}:</span>
                              <span className="font-medium">{result.takafulAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
                            </div>
                          )}
                          <div className="flex justify-between text-sm border-b pb-1">
                            <span className="text-muted-foreground">{t("BankValuation" as any) || "Bank Valuation"}:</span>
                            <span className="font-medium">{result.actualValuation > 0 ? result.actualValuation.toLocaleString(undefined, {minimumFractionDigits: 2}) : (t("NotSet" as any) || "Not Set")}</span>
                          </div>
                          
                          {result.exceedsValuation && (
                            <div className="bg-red-50 text-red-600 p-2 rounded text-xs mt-2 space-y-1">
                              <p className="font-semibold">{t("ExceedsLimit" as any) || "Exceeds Financing Limit"}</p>
                              <p>{t("MaxFinancing" as any) || "Max Allowed"}: {result.maxFinancingAllowed.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</p>
                              <p>{t("MinDownPayment" as any) || "Min Down Payment"}: {result.minimumDownPayment.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</p>
                            </div>
                          )}
                          
                          {result.companyRules && result.companyRules.length > 0 && (
                            <div className="mt-3">
                              <p className="text-xs font-semibold text-muted-foreground mb-1">{t("Conditions" as any) || "Conditions / Required Docs"}</p>
                              <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                                {result.companyRules.map((r: any) => (
                                  <li key={r._id}>{r.documentName} {r.isRequired ? "*" : ""}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    
                    {!result.isCash && (
                      <div className="bg-primary/5 p-3 rounded-md mb-4 text-center">
                        <div className="text-sm text-primary font-medium mb-1">{t("Monthly Installment" as any)}</div>
                        <div className="text-2xl font-bold text-primary">{result.monthlyInstallment.toLocaleString(undefined, {minimumFractionDigits: 2})} <span className="text-sm font-normal">JOD</span></div>
                      </div>
                    )}

                    <Button 
                      type="button" 
                      className="w-full mt-auto" 
                      variant={result.isCash ? "outline" : result.exceedsValuation ? "destructive" : "default"}
                      onClick={() => onSelectQuote(result)}
                      disabled={isSubmitting || result.exceedsValuation}
                    >
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      {result.exceedsValuation ? (t("IncreaseDownPayment" as any) || "Increase Down Payment") : (t("SelectSave" as any) || "Select & Save")}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>

          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
