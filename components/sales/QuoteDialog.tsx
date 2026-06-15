"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { calculateUnifiedMurabaha } from "@/lib/financing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2 } from "lucide-react";

import { quoteSchema, QuoteFormValues, QuoteDialogProps } from "./quote.schema";


export function QuoteDialog({ open, onOpenChange, defaultVehicleId, defaultCustomerId }: QuoteDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const { results: customers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const availableVehicles = useQuery(
    api.vehicles.listAll,
    activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip"
  );
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
      companyName: t("CashDeal" as any),
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
      toast.error(t("ExceedsFinancingLimit" as any));
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
      toast.success(t("QuoteSavedSuccess" as any));
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || t("QuoteSaveFail" as any));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("SmartQuoteComparison" as any)}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form className="space-y-4">
            <div className="bg-muted p-4 rounded-lg grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="vehicleId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Vehicle" as any)} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={(val) => {
                          field.onChange(val);
                          const v = availableVehicles?.find(v => v._id === val);
                          if (v) form.setValue("vehiclePrice", v.sellingPrice);
                        }}
                        placeholder={t("SelectVehicle" as any)}
                        options={availableVehicles?.map((v) => ({
                          value: v._id,
                          label: `${v.year} ${v.make} ${v.model}`,
                          subLabel: `${v.sellingPrice.toLocaleString()} JOD`,
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
                name="termMonths"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("TermMonths" as any)}</FormLabel>
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
                    <FormLabel>{t("VehiclePriceJOD" as any)}</FormLabel>
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
                    <FormLabel>{t("DownPayment" as any)}</FormLabel>
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
                      {result.isCash && <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">{t("Cash" as any)}</span>}
                      {!result.isCash && <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded-full">{result.profitRateApplied}% {t("Rate" as any)}</span>}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col justify-between">
                    <div className="space-y-2 mb-4">
                      {result.isCash ? (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{t("TotalToPay" as any)}:</span>
                          <span className="font-semibold">{result.totalFinancedAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</span>
                        </div>
                      ) : (
                        <>
                          <div className="flex justify-between text-sm border-b pb-1">
                            <span className="text-muted-foreground">{t("FinancedAmount" as any)}:</span>
                            <span className="font-medium">{result.totalFinancedAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                          </div>
                          <div className="flex justify-between text-sm border-b pb-1">
                            <span className="text-muted-foreground">{t("TotalProfit" as any)}:</span>
                            <span className="font-medium">{result.totalProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                          </div>
                          {result.takafulAmount > 0 && (
                            <div className="flex justify-between text-sm border-b pb-1">
                              <span className="text-muted-foreground">{t("Takaful" as any)}:</span>
                              <span className="font-medium">{result.takafulAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                            </div>
                          )}
                          <div className="flex justify-between text-sm border-b pb-1">
                            <span className="text-muted-foreground">{t("BankValuation" as any)}:</span>
                            <span className="font-medium">{result.actualValuation > 0 ? result.actualValuation.toLocaleString(undefined, { minimumFractionDigits: 2 }) : (t("NotSet" as any))}</span>
                          </div>

                          {result.exceedsValuation && (
                            <div className="bg-red-50 text-red-600 p-2 rounded text-xs mt-2 space-y-1">
                              <p className="font-semibold">{t("ExceedsLimit" as any)}</p>
                              <p>{t("MaxFinancing" as any)}: {result.maxFinancingAllowed.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</p>
                              <p>{t("MinDownPayment" as any)}: {result.minimumDownPayment.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</p>
                            </div>
                          )}

                          {result.companyRules && result.companyRules.length > 0 && (
                            <div className="mt-3">
                              <p className="text-xs font-semibold text-muted-foreground mb-1">{t("Conditions" as any)}</p>
                              <ul className="text-xs text-muted-foreground space-y-1 list-disc ps-4">
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
                        <div className="text-sm text-primary font-medium mb-1">{t("MonthlyInstallment" as any)}</div>
                        <div className="text-2xl font-bold text-primary">{result.monthlyInstallment.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-sm font-normal">JOD</span></div>
                      </div>
                    )}

                    <Button
                      type="button"
                      className="w-full mt-auto"
                      variant={result.isCash ? "outline" : result.exceedsValuation ? "destructive" : "default"}
                      onClick={() => onSelectQuote(result)}
                      disabled={isSubmitting || result.exceedsValuation}
                    >
                      <CheckCircle2 className="w-4 h-4 me-2" />
                      {result.exceedsValuation ? (t("IncreaseDownPayment" as any)) : (t("SelectSave" as any))}
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
