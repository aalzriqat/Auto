"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Check, Zap } from "lucide-react";
import { toast } from "@/components/ui/sonner";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700 border-green-200",
  past_due: "bg-amber-100 text-amber-700 border-amber-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  expired: "bg-red-100 text-red-700 border-red-200",
};

const PLAN_ORDER = ["free", "starter", "professional", "enterprise"] as const;

function UsageBar({ label, current, max }: { label: string; current: number; max: number }) {
  const isUnlimited = max === -1;
  const pct = isUnlimited ? 0 : Math.min((current / max) * 100, 100);
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span className="text-slate-600 font-medium">{label}</span>
        <span className="text-slate-500 tabular-nums font-mono text-xs">
          {isUnlimited ? `${current} / ∞` : `${current} / ${max}`}
        </span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        {isUnlimited ? (
          <div className="h-full w-1 bg-emerald-500 rounded-full" />
        ) : (
          <div className={cn("h-full rounded-full transition-all duration-500", barColor)} style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { activeOrgId } = useOrg();
  const { t, isRtl } = useLanguage();
  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">("monthly");
  const [upgradeTarget, setUpgradeTarget] = useState<{ planId: string; planName: string } | null>(null);
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const subscription = useQuery(api.subscriptions.getMySubscription, activeOrgId ? { orgId: activeOrgId } : "skip");
  const usage = useQuery(api.subscriptions.getUsageStats, activeOrgId ? { orgId: activeOrgId } : "skip");
  const plans = useQuery(api.subscriptions.getPlans);
  const showPricing = useQuery(api.subscriptions.getShowPricing);
  const requestUpgrade = useAction(api.subscriptions.requestUpgrade);

  if (!subscription || !usage || !plans || showPricing === undefined) {
    return (
      <div className="flex-1 p-4 md:p-8 pt-6 space-y-4">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-slate-100 rounded" />
          <div className="h-40 bg-slate-100 rounded-xl" />
          <div className="h-64 bg-slate-100 rounded-xl" />
        </div>
      </div>
    );
  }

  const currentPlanId = subscription.plan ?? "free";
  const currentStatus = subscription.status ?? "active";
  const currentPeriodEnd = subscription.currentPeriodEnd;

  type PlanRow = (typeof plans)[number];
  const orderedPlans = PLAN_ORDER
    .map((id) => (plans as PlanRow[]).find((pl) => pl.id === id))
    .filter((pl): pl is PlanRow => pl !== undefined);

  async function handleUpgradeSubmit() {
    if (!upgradeTarget || !activeOrgId || !phone.trim()) return;
    setSubmitting(true);
    try {
      await requestUpgrade({
        orgId: activeOrgId,
        targetPlan: upgradeTarget.planId,
        phone: phone.trim(),
        message: message.trim() || undefined,
      });
      toast.success(t("UpgradeRequestSent" as any));
      setUpgradeTarget(null);
      setPhone("");
      setMessage("");
    } catch {
      toast.error(t("UpgradeRequestFailed" as any));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex-1 space-y-6 p-4 md:p-8 pt-6" dir={isRtl ? "rtl" : "ltr"}>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("BillingTitle" as any)}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("BillingDesc" as any)}</p>
      </div>

      {/* ── Current Plan ─────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-base">{t("CurrentPlan" as any)}</CardTitle>
              <CardDescription className="mt-1">
                {currentPlanId === "free"
                  ? t("FreePlanNote" as any)
                  : currentPeriodEnd
                    ? `${t("RenewsOn" as any)} ${new Date(currentPeriodEnd).toLocaleDateString()}`
                    : null}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="text-sm px-3 py-1 font-semibold bg-primary/10 text-primary border-primary/20">
                {isRtl ? subscription.planDetails.nameAr : subscription.planDetails.name}
              </Badge>
              <Badge variant="outline" className={cn("text-xs capitalize", STATUS_COLORS[currentStatus] ?? "")}>
                {t((`PlanStatus_${currentStatus}`) as any)}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <UsageBar label={t("VehiclesUsed" as any)} current={usage.vehicleCount} max={usage.maxVehicles} />
          <UsageBar label={t("MembersUsed" as any)} current={usage.memberCount} max={usage.maxUsers} />
        </CardContent>
      </Card>

      {/* ── Billing Interval Toggle ────────────────────── */}
      {showPricing && (
        <div className="flex items-center gap-3">
          <span className={cn("text-sm font-medium transition-colors", billingInterval === "monthly" ? "text-slate-900" : "text-slate-400")}>
            {t("BillingToggleMonthly" as any)}
          </span>
          <button
            onClick={() => setBillingInterval((prev) => (prev === "monthly" ? "annual" : "monthly"))}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              billingInterval === "annual" ? "bg-primary" : "bg-slate-200"
            )}
            aria-label="Toggle billing interval"
          >
            <span
              className={cn(
                "inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform",
                billingInterval === "annual"
                  ? "translate-x-5 rtl:translate-x-0.5"
                  : "translate-x-0.5 rtl:translate-x-5"
              )}
            />
          </button>
          <span className={cn("text-sm font-medium transition-colors", billingInterval === "annual" ? "text-slate-900" : "text-slate-400")}>
            {t("BillingToggleAnnual" as any)}
          </span>
          {billingInterval === "annual" && (
            <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-xs font-semibold">
              {t("BillingSave20" as any)}
            </Badge>
          )}
        </div>
      )}

      {/* ── Plan Cards ────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {orderedPlans.map((p: PlanRow) => {
          const isCurrent = p.id === currentPlanId;
          const isFree = p.id === "free";
          const price = billingInterval === "annual" ? p.annualPriceJod : p.priceJod;
          const planName = isRtl ? (p as any).nameAr ?? p.name : p.name;
          const features: string[] = isRtl
            ? (p as any).featuresAr ?? p.features
            : (p.features as readonly string[]);

          return (
            <Card
              key={p.id}
              className={cn(
                "relative flex flex-col transition-shadow",
                isCurrent ? "border-primary shadow-md ring-1 ring-primary/20" : "hover:shadow-sm border-slate-200"
              )}
            >
              {isCurrent && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
                  <Badge className="bg-primary text-primary-foreground text-[11px] px-3 shadow-sm">
                    {t("CurrentPlanBadge" as any)}
                  </Badge>
                </div>
              )}

              <CardHeader className="pb-3 pt-6">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-bold">{planName}</CardTitle>
                </div>

                {showPricing && (
                  <div className="mt-3">
                    {isFree ? (
                      <div className="flex items-baseline gap-1">
                        <span className="text-3xl font-extrabold text-slate-800">0</span>
                        <span className="text-sm text-slate-500">JOD{t("PerMonth" as any)}</span>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className="text-3xl font-extrabold text-slate-800">{price}</span>
                        <span className="text-sm text-slate-500">JOD{t("PerMonth" as any)}</span>
                      </div>
                    )}
                    {!isFree && billingInterval === "annual" && (
                      <p className="text-[11px] text-slate-400 mt-0.5">{t("BilledAnnually" as any)}</p>
                    )}
                  </div>
                )}
              </CardHeader>

              <CardContent className="flex-1 flex flex-col gap-4 pt-0">
                <ul className="space-y-2 flex-1 min-h-[120px]">
                  {features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                      <Check className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <Button variant="outline" className="w-full cursor-default opacity-60" disabled>
                    {t("CurrentPlanBadge" as any)}
                  </Button>
                ) : (
                  <Button
                    className="w-full gap-2"
                    onClick={() => setUpgradeTarget({ planId: p.id, planName })}
                  >
                    {t("ContactToUpgrade" as any)}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Contact Note ─────────────────────────────────── */}
      <Card className="bg-amber-50 border-amber-200">
        <CardContent className="p-4 flex items-start gap-3">
          <Zap className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-slate-800">{t("BillingContactTitle" as any)}</p>
            <p className="text-xs text-slate-600 mt-0.5">
              {t("BillingContactDesc" as any)}{" "}
              <a href="mailto:subscriptions@autoflowdealer.com" className="text-primary font-medium underline-offset-2 hover:underline">
                subscriptions@autoflowdealer.com
              </a>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── Upgrade Request Dialog ────────────────────────── */}
      <Dialog open={!!upgradeTarget} onOpenChange={(open) => { if (!open) { setUpgradeTarget(null); setPhone(""); setMessage(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("UpgradeRequestTitle" as any)}</DialogTitle>
            <DialogDescription>{t("UpgradeRequestDesc" as any)}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="rounded-lg bg-slate-50 border px-4 py-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-500">{t("CurrentPlan" as any)}</span>
                <span className="font-medium">{isRtl ? subscription.planDetails.nameAr : subscription.planDetails.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t("UpgradeRequestPlan" as any)}</span>
                <span className="font-bold text-primary">{upgradeTarget?.planName}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="upgrade-phone">{t("UpgradeRequestPhone" as any)} <span className="text-red-500">*</span></Label>
              <Input
                id="upgrade-phone"
                type="tel"
                placeholder={t("UpgradeRequestPhonePlaceholder" as any)}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="upgrade-message">{t("UpgradeRequestMessage" as any)}</Label>
              <Textarea
                id="upgrade-message"
                placeholder={t("UpgradeRequestMessagePlaceholder" as any)}
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setUpgradeTarget(null); setPhone(""); setMessage(""); }}>
              {t("Cancel" as any)}
            </Button>
            <Button onClick={handleUpgradeSubmit} disabled={!phone.trim() || submitting}>
              {submitting ? t("Sending" as any) : t("SendUpgradeRequest" as any)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
