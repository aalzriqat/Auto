"use client";

import { useState } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { SalesWizard, WizardDraft } from "@/components/sales/SalesWizard";
import { PaymentType, WizardData } from "@/components/sales/wizard/types";
import { Banknote, CreditCard, TrendingUp, ArrowRight, Clock, CheckCircle2, RotateCcw, FileEdit } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Id } from "@/convex/_generated/dataModel";

export default function SalesHomePage() {
    const { activeOrgId } = useOrg();
    const { t } = useLanguage();
    const [activeWizard, setActiveWizard] = useState<PaymentType | null>(null);
    const [wizardInitialDraft, setWizardInitialDraft] = useState<Partial<WizardData> | undefined>();
    const [wizardResumeDraft, setWizardResumeDraft] = useState<WizardDraft | undefined>();

    const { results: recentSales } = usePaginatedQuery(
        api.sales.list,
        activeOrgId ? { orgId: activeOrgId } : "skip",
        { initialNumItems: 5 }
    );

    const myPendingApprovals = useQuery(
        api.approvals.listMyPendingApprovals,
        activeOrgId ? { orgId: activeOrgId } : "skip"
    );

    const myWizardDraft = useQuery(
        api.wizardDrafts.getMyDraft,
        activeOrgId ? { orgId: activeOrgId as Id<"organizations"> } : "skip"
    );

    function openFreshWizard(type: PaymentType) {
        setWizardInitialDraft(undefined);
        setWizardResumeDraft(undefined);
        setActiveWizard(type);
    }

    function resumeFromApproval(approval: NonNullable<typeof myPendingApprovals>[0]) {
        if (!approval.wizardSnapshot) return;
        const snap = approval.wizardSnapshot;
        setWizardInitialDraft({
            vehicleId: approval.vehicleId,
            vehiclePrice: snap.vehiclePrice,
            desiredProfit: snap.desiredProfit,
            downPayment: snap.downPayment,
            termMonths: snap.termMonths,
            selectedCompanyId: snap.selectedCompanyId,
        });
        setWizardResumeDraft(undefined);
        setActiveWizard(snap.paymentType as PaymentType);
    }

    function resumeFromDbDraft(draft: NonNullable<typeof myWizardDraft>) {
        setWizardInitialDraft(undefined);
        setWizardResumeDraft({
            paymentType: draft.paymentType as PaymentType,
            currentStep: draft.currentStep,
            wizardData: draft.wizardData as WizardData,
            selectedCustomerId: draft.selectedCustomerId ?? null,
            savedAt: draft.savedAt,
        });
        setActiveWizard(draft.paymentType as PaymentType);
    }

    // If wizard is active, render it full-width instead of the hero
    if (activeWizard) {
        return (
            <RoleGuard permissions={["view:sales"]}>
                <SalesWizard
                    paymentType={activeWizard}
                    onClose={() => { setActiveWizard(null); setWizardInitialDraft(undefined); setWizardResumeDraft(undefined); }}
                    initialDraft={wizardInitialDraft}
                    resumeDraft={wizardResumeDraft}
                />
            </RoleGuard>
        );
    }

    return (
        <RoleGuard permissions={["view:sales"]}>
            <div className="space-y-10 pb-10">

                {/* ─── Hero Section ─────────────────────────────────────────── */}
                <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-white/10 p-8 md:p-12">
                    {/* Decorative blobs */}
                    <div className="pointer-events-none absolute -top-20 -right-20 w-80 h-80 rounded-full bg-teal-500/10 blur-3xl" />
                    <div className="pointer-events-none absolute -bottom-20 -left-20 w-80 h-80 rounded-full bg-indigo-500/10 blur-3xl" />

                    <div className="relative z-10 flex flex-col items-center text-center">
                        <div className="flex items-center justify-center gap-2 mb-2">
                            <TrendingUp className="w-5 h-5 text-teal-400" />
                            <span className="text-sm font-medium text-teal-400 uppercase tracking-wider">
                                {t("SalesPortal" as any)}
                            </span>
                        </div>
                        <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
                            {t("StartNewSale" as any)}
                        </h1>
                        <p className="text-slate-400 text-base mb-10 max-w-lg mx-auto">
                            {t("ChoosePaymentType" as any)}
                        </p>

                        {/* Launch Buttons */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl w-full">
                            {/* Cash */}
                            <button
                                id="btn-new-cash-sale"
                                onClick={() => openFreshWizard("CASH")}
                                className={cn(
                                    "group relative flex flex-col items-start gap-4 rounded-xl border border-teal-500/30 bg-teal-500/10",
                                    "hover:bg-teal-500/20 hover:border-teal-500/60 hover:shadow-lg hover:shadow-teal-500/10",
                                    "transition-all duration-300 p-6 text-start cursor-pointer"
                                )}
                            >
                                <div className="flex items-center justify-between w-full">
                                    <div className="w-12 h-12 rounded-xl bg-teal-500/20 border border-teal-500/30 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                                        <Banknote className="w-6 h-6 text-teal-400" />
                                    </div>
                                    <ArrowRight className="w-5 h-5 text-teal-500/50 group-hover:text-teal-400 group-hover:translate-x-1 transition-all duration-300" />
                                </div>
                                <div>
                                    <p className="text-white font-bold text-xl">{t("CashSale" as any)}</p>
                                    <p className="text-slate-400 text-sm mt-1">
                                        {t("FullPaymentUpfront" as any)}
                                    </p>
                                </div>
                                <div className="text-xs font-medium text-teal-400 bg-teal-500/10 border border-teal-500/20 rounded-full px-3 py-1">
                                    {t("ThreeStepWizard" as any)}
                                </div>
                            </button>

                            {/* Installment */}
                            <button
                                id="btn-new-installment-sale"
                                onClick={() => openFreshWizard("INSTALLMENT")}
                                className={cn(
                                    "group relative flex flex-col items-start gap-4 rounded-xl border border-indigo-500/30 bg-indigo-500/10",
                                    "hover:bg-indigo-500/20 hover:border-indigo-500/60 hover:shadow-lg hover:shadow-indigo-500/10",
                                    "transition-all duration-300 p-6 text-start cursor-pointer"
                                )}
                            >
                                <div className="flex items-center justify-between w-full">
                                    <div className="w-12 h-12 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                                        <CreditCard className="w-6 h-6 text-indigo-400" />
                                    </div>
                                    <ArrowRight className="w-5 h-5 text-indigo-500/50 group-hover:text-indigo-400 group-hover:translate-x-1 transition-all duration-300" />
                                </div>
                                <div>
                                    <p className="text-white font-bold text-xl">{t("Installment" as any)}</p>
                                    <p className="text-slate-400 text-sm mt-1">
                                        {t("FinanceThroughBank" as any)}
                                    </p>
                                </div>
                                <div className="text-xs font-medium text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-3 py-1">
                                    {t("ThreeStepWizard" as any)}
                                </div>
                            </button>
                        </div>
                    </div>
                </div>

                {/* ─── In-Progress Draft ────────────────────────────────────── */}
                {myWizardDraft && (
                    <div>
                        <h2 className="text-sm font-semibold mb-3 text-indigo-400 uppercase tracking-wider flex items-center gap-2">
                            <FileEdit className="w-4 h-4" />
                            {t("InProgressDraft" as any) ?? "In-Progress Draft"}
                        </h2>
                        <div
                            className="flex items-center justify-between rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-4 py-3"
                        >
                            <div>
                                <p className="text-sm font-medium text-foreground">
                                    {myWizardDraft.paymentType === "CASH"
                                        ? (t("CashSale" as any) ?? "Cash Sale")
                                        : (t("Installment" as any) ?? "Installment")}
                                    {" — "}{t("StepOf" as any, { step: myWizardDraft.currentStep, total: 3 }) ?? `Step ${myWizardDraft.currentStep} of 3`}
                                </p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    {t("LastSaved" as any) ?? "Last saved"}: {new Date(myWizardDraft.savedAt).toLocaleString()}
                                </p>
                            </div>
                            <Button
                                size="sm"
                                variant="outline"
                                className="text-xs border-indigo-400 text-indigo-400 hover:bg-indigo-500/10"
                                onClick={() => resumeFromDbDraft(myWizardDraft)}
                            >
                                <RotateCcw className="w-3 h-3 me-1.5" />
                                {t("ResumeDraft" as any) ?? "Resume Draft"}
                            </Button>
                        </div>
                    </div>
                )}

                {/* ─── Pending Deals (awaiting approval) ───────────────────── */}
                {myPendingApprovals && myPendingApprovals.length > 0 && (
                    <div>
                        <h2 className="text-sm font-semibold mb-3 text-amber-400 uppercase tracking-wider flex items-center gap-2">
                            <Clock className="w-4 h-4" />
                            {t("PendingDeals" as any) ?? "Pending Deals"}
                        </h2>
                        <div className="space-y-2">
                            {myPendingApprovals.map((approval) => (
                                <div
                                    key={approval._id}
                                    className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3"
                                >
                                    <div>
                                        <p className="text-sm font-medium text-foreground">{approval.vehicleSummary}</p>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            {t("RequestedProfit" as any) ?? "Requested profit"}: {approval.requestedProfit.toLocaleString()} JOD
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {approval.status === "PENDING" ? (
                                            <Badge variant="outline" className="text-amber-600 border-amber-400 text-xs">
                                                <Clock className="w-3 h-3 me-1" />
                                                {t("AwaitingApproval" as any) ?? "Awaiting Approval"}
                                            </Badge>
                                        ) : (
                                            <Badge variant="outline" className="text-green-600 border-green-400 text-xs">
                                                <CheckCircle2 className="w-3 h-3 me-1" />
                                                {t("Approved" as any) ?? "Approved"}
                                            </Badge>
                                        )}
                                        {approval.wizardSnapshot && (
                                            <Button
                                                size="sm"
                                                variant={approval.status === "APPROVED" ? "default" : "outline"}
                                                className={cn(
                                                    "text-xs",
                                                    approval.status === "APPROVED" && "bg-green-600 hover:bg-green-700 text-white"
                                                )}
                                                onClick={() => resumeFromApproval(approval)}
                                            >
                                                <RotateCcw className="w-3 h-3 me-1.5" />
                                                {t("ResumeDeal" as any) ?? "Resume Deal"}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* ─── Recent Sales ──────────────────────────────────────────── */}
                {recentSales && recentSales.length > 0 && (
                    <div>
                        <h2 className="text-lg font-semibold mb-4 text-muted-foreground uppercase tracking-wider text-sm">
                            {t("RecentSalesTitle" as any)}
                        </h2>
                        <div className="space-y-2">
                            {recentSales.map((sale) => (
                                <div
                                    key={sale._id}
                                    className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 hover:bg-muted/30 transition-colors"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground">
                                            {sale.customerName.charAt(0)}
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium">{sale.customerName}</p>
                                            <p className="text-xs text-muted-foreground">{sale.vehicleSummary}</p>
                                        </div>
                                    </div>
                                    <div className="text-end">
                                        <p className="text-sm font-semibold">
                                            {sale.salePrice.toLocaleString(undefined, {
                                                minimumFractionDigits: 2,
                                                maximumFractionDigits: 2,
                                            })}{" "}
                                            {t("JOD" as any)}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {new Date(sale.saleDate).toLocaleDateString()}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </RoleGuard>
    );
}