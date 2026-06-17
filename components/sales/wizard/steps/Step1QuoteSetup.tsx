"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { PaymentType, WizardData } from "../types";
import { step1Schema } from "../schemas";

import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";


import { ArrowRight, Banknote, CreditCard, TrendingUp, ShieldAlert, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import VehiclePicker from "../components/VehiclePicker";
import { FinancePanel } from "../components/FinancePanel";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { VehicleCostBar } from "../components/VehicleCostBar";

export type Step1Values = z.infer<typeof step1Schema>;

// ─────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────

interface Step1QuoteSetupProps {
  paymentType: PaymentType;
  initialData: WizardData;
  onNext: (data: WizardData) => void;
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

export default function Step1QuoteSetup({
  paymentType,
  initialData,
  onNext,
}: Step1QuoteSetupProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const isCash = paymentType === "CASH";

  const [selectedCompanyId, setSelectedCompanyId] = useState<
    string | undefined
  >(initialData.selectedCompanyId);

  const [customerStatuses, setCustomerStatuses] = useState<string[]>([]);

  const toggleStatus = (id: string) => {
    setCustomerStatuses((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
    setSelectedCompanyId(undefined); // Reset selection when requirements change
  };

  const customerStatusOptions = useQuery(
    api.orgCustomerStatuses.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  )?.filter((s) => s.isActive) ?? [];

  const availableVehicles = useQuery(
    api.vehicles.listAll,
    activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip"
  );

  const form = useForm<Step1Values>({
    resolver: zodResolver(step1Schema),
    defaultValues: {
      vehicleId: initialData.vehicleId,
      vehiclePrice: initialData.vehiclePrice,
      desiredProfit: initialData.desiredProfit,
      downPayment: initialData.downPayment,
      termMonths: initialData.termMonths || 84,
    },
  });

  const watchedVehicleId = form.watch("vehicleId");
  const watchedPrice = form.watch("vehiclePrice");
  const watchedProfit = form.watch("desiredProfit");
  const watchedDown = form.watch("downPayment");
  const watchedTerm = form.watch("termMonths");

  const selectedVehicle = availableVehicles?.find(v => v._id === watchedVehicleId);
  const minimumProfit = selectedVehicle?.minimumProfit || 0;
  const isProfitBelowMinimum = !isCash && watchedVehicleId && Number(watchedProfit) < minimumProfit;

  const pendingApproval = useQuery(api.approvals.checkPendingApproval,
    activeOrgId && watchedVehicleId
      ? { orgId: activeOrgId, vehicleId: watchedVehicleId as Id<"vehicles"> }
      : "skip"
  );

  const requestProfitApproval = useMutation(api.approvals.requestProfitApproval);
  const [isRequesting, setIsRequesting] = useState(false);

  const hasValidApproval = pendingApproval?.status === "APPROVED" && Number(watchedProfit) >= pendingApproval.requestedProfit;
  const isBlockedByProfit = isProfitBelowMinimum && !hasValidApproval;

  const handleRequestApproval = async () => {
    if (!activeOrgId || !watchedVehicleId) return;
    setIsRequesting(true);
    try {
      await requestProfitApproval({
        orgId: activeOrgId,
        vehicleId: watchedVehicleId as Id<"vehicles">,
        requestedProfit: Number(watchedProfit) || 0,
        minimumProfit: minimumProfit,
        wizardSnapshot: {
          paymentType,
          vehiclePrice: Number(watchedPrice) || 0,
          desiredProfit: Number(watchedProfit) || 0,
          downPayment: Number(watchedDown) || 0,
          termMonths: Number(watchedTerm) || 84,
          selectedCompanyId: selectedCompanyId,
        },
      });
    } finally {
      setIsRequesting(false);
    }
  };

  const onSubmit = (values: Step1Values) => {
    if (paymentType === "INSTALLMENT" && !selectedCompanyId) {
      form.setError("vehicleId", {
        message: "Please select a financing company",
      });
      return;
    }

    if (isBlockedByProfit) {
      return;
    }

    onNext({
      ...values,
      selectedCompanyId,
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

        {/* Header badge */}
        <div
          className={cn(
            "rounded-xl border p-4 flex items-center gap-3",
            isCash
              ? "border-teal-500/30 bg-teal-500/5"
              : "border-indigo-500/30 bg-indigo-500/5"
          )}
        >
          {isCash ? (
            <Banknote className="w-6 h-6 text-teal-400" />
          ) : (
            <CreditCard className="w-6 h-6 text-indigo-400" />
          )}

          <div>
            <p className="font-semibold">
              {isCash ? t("CashDeal" as any) : t("InstallmentQuote" as any)}
            </p>
            <p className="text-sm text-muted-foreground">
              {isCash
                ? t("FullPaymentNoFinance" as any)
                : t("FinanceWithInstallments" as any)}
            </p>
          </div>

          <Badge className="ms-auto" variant="outline">
            {isCash ? t("Cash" as any) : t("Financed" as any)}
          </Badge>
        </div>

        {/* Vehicle */}
        <FormField
          control={form.control}
          name="vehicleId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("Vehicle" as any)}</FormLabel>
              <FormControl>
                <VehiclePicker
                  vehicles={availableVehicles}
                  value={field.value}
                  onChange={(id, price) => {
                    field.onChange(id);
                    form.setValue("vehiclePrice", price);
                    setSelectedCompanyId(undefined);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Vehicle cost breakdown — visible when a vehicle is selected */}
        {selectedVehicle && (
          <VehicleCostBar
            vehicleId={selectedVehicle._id}
            purchasePrice={selectedVehicle.purchasePrice}
            salePrice={Number(watchedPrice) || selectedVehicle.sellingPrice}
          />
        )}

        {/* Pricing */}
        <div
          className={cn(
            "grid gap-4",
            isCash ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 md:grid-cols-4"
          )}
        >
          <FormField
            control={form.control}
            name="vehiclePrice"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("VehiclePriceJOD" as any)}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    {...field}
                    onChange={(e) => {
                      field.onChange(e);
                      setSelectedCompanyId(undefined);
                    }}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          {!isCash && (
            <>
              <FormField
                control={form.control}
                name="desiredProfit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1">
                      <TrendingUp className="w-3 h-3 text-indigo-400" />
                      {t("DealerProfit" as any)}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => {
                          field.onChange(e);
                          setSelectedCompanyId(undefined);
                        }}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="downPayment"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("DownPayment" as any)}</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
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
                  </FormItem>
                )}
              />
            </>
          )}
        </div>

        {/* Customer Statuses */}
        {!isCash && (
          <div className="space-y-3">
            <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              {t("CustomerStatusReqs")}
            </label>
            {customerStatusOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("NoCustomerStatusesConfigured" as any) ?? "No customer statuses configured yet — set them up in Finance Settings."}
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
                {customerStatusOptions.map((option) => (
                  <div key={option._id} className="flex items-center gap-2 rounded-md border p-4">
                    <Checkbox
                      id={`status-${option._id}`}
                      checked={customerStatuses.includes(option._id)}
                      onCheckedChange={() => toggleStatus(option._id)}
                    />
                    <label
                      htmlFor={`status-${option._id}`}
                      className="font-normal text-sm cursor-pointer select-none leading-none"
                    >
                      {option.label}
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Finance panel */}
        {!isCash && (
          <FinancePanel
            vehicleId={watchedVehicleId}
            vehiclePrice={Number(watchedPrice) || 0}
            desiredProfit={Number(watchedProfit) || 0}
            downPayment={Number(watchedDown) || 0}
            termMonths={Number(watchedTerm) || 0}
            selectedCompanyId={selectedCompanyId}
            onSelectCompany={setSelectedCompanyId}
            customerStatuses={customerStatuses}
          />
        )}

        {/* Approval Alert */}
        {isBlockedByProfit && (
          <Alert variant="destructive" className="bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Approval Required</AlertTitle>
            <AlertDescription className="mt-2 flex flex-col gap-3 items-start">
              <p>The desired profit ({Number(watchedProfit)} JOD) is below the minimum required profit for this vehicle ({minimumProfit} JOD).</p>

              {pendingApproval?.status === "PENDING" && pendingApproval.requestedProfit === Number(watchedProfit) ? (
                <div className="flex items-center gap-2 text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 px-3 py-1.5 rounded-md text-sm font-medium">
                  Approval request is currently pending. Please wait for a manager.
                </div>
              ) : pendingApproval?.status === "REJECTED" && pendingApproval.requestedProfit === Number(watchedProfit) ? (
                <div className="flex items-center gap-2 text-red-600 dark:text-red-400 bg-red-500/10 px-3 py-1.5 rounded-md text-sm font-medium">
                  Your request for this profit amount was rejected. Please increase the profit or request again.
                </div>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleRequestApproval}
                  disabled={isRequesting}
                >
                  {isRequesting ? "Requesting..." : "Request Profit Approval"}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {hasValidApproval && isProfitBelowMinimum && (
          <Alert className="bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <AlertTitle>Profit Approved</AlertTitle>
            <AlertDescription>
              Your requested profit of {pendingApproval.requestedProfit} JOD was approved by management. You may proceed.
            </AlertDescription>
          </Alert>
        )}

        {/* Footer */}
        <div className="flex justify-end pt-4 border-t">
          <Button type="submit" disabled={!!isBlockedByProfit} className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg transition-all rounded-full px-8 h-12">
            {t("Next" as any)}
            <ArrowRight className="w-4 h-4 ms-2" />
          </Button>
        </div>
      </form>
    </Form>
  );
}