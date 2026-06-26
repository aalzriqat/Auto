"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useState, useEffect } from "react";

const PLANS = ["free", "starter", "professional", "enterprise"] as const;
const STATUSES = ["active", "past_due", "cancelled", "expired"] as const;
const BILLING_INTERVALS = ["monthly", "annual"] as const;

type Plan = (typeof PLANS)[number];
type SubStatus = (typeof STATUSES)[number];
type BillingInterval = (typeof BILLING_INTERVALS)[number];

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  past_due: "bg-amber-100 text-amber-700",
  cancelled: "bg-slate-100 text-slate-600",
  expired: "bg-red-100 text-red-700",
};

function toDateInputValue(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

function fromDateInputValue(val: string): number | undefined {
  if (!val) return undefined;
  return new Date(val).getTime();
}

export default function AdminOrgDetailPage() {
  const params = useParams<{ orgId: string }>();
  const orgId = params.orgId as Id<"organizations">;
  const detail = useQuery(api.adminOrgs.getOrgDetail, { orgId });
  const updateSubscription = useMutation(api.subscriptions.adminUpdateSubscription);

  const [plan, setPlan] = useState<Plan>("free");
  const [subStatus, setSubStatus] = useState<SubStatus>("active");
  const [billingInterval, setBillingInterval] = useState<BillingInterval | "none">("none");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!detail) return;
    const sub = detail.subscription;
    setPlan((sub?.plan as Plan) ?? "free");
    setSubStatus((sub?.status as SubStatus) ?? "active");
    setBillingInterval((sub?.billingInterval as BillingInterval) ?? "none");
    setPeriodStart(toDateInputValue(sub?.currentPeriodStart));
    setPeriodEnd(toDateInputValue(sub?.currentPeriodEnd));
  }, [detail]);

  async function handleSave() {
    setSaving(true);
    try {
      await updateSubscription({
        orgId,
        plan,
        status: subStatus,
        billingInterval: billingInterval === "none" ? undefined : billingInterval,
        currentPeriodStart: fromDateInputValue(periodStart),
        currentPeriodEnd: fromDateInputValue(periodEnd),
      });
      toast.success("Subscription updated");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update subscription");
    } finally {
      setSaving(false);
    }
  }

  if (!detail) {
    return <p className="text-slate-400 text-sm">Loading...</p>;
  }

  const { org, settings, counts, subscription } = detail;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{org.name}</h1>
          <p className="text-sm text-slate-400">
            Created {new Date(org.createdAt).toLocaleDateString()} ·{" "}
            {org.suspended
              ? <Badge variant="destructive">Suspended</Badge>
              : <Badge variant="secondary">Active</Badge>}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href={`/admin/data?orgId=${orgId}`}>Browse data for this org</Link>
        </Button>
      </div>

      {org.suspended && org.suspendedReason && (
        <Card className="border-red-200">
          <CardContent className="pt-6 text-sm text-red-700">
            Suspended reason: {org.suspendedReason}
          </CardContent>
        </Card>
      )}

      {/* ── Subscription Editor ─────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Subscription</CardTitle>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_COLORS[subscription?.status ?? "active"] ?? ""}`}>
                {subscription?.status ?? "active"}
              </span>
              <Badge variant="secondary" className="capitalize text-xs">
                {subscription?.plan ?? "free"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-slate-300">Plan</Label>
              <Select value={plan} onValueChange={(v) => setPlan(v as Plan)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLANS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-slate-300">Status</Label>
              <Select value={subStatus} onValueChange={(v) => setSubStatus(v as SubStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace("_", " ").replace(/^\w/, (c) => c.toUpperCase())}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-slate-300">Billing interval <span className="text-slate-500">(optional)</span></Label>
              <Select value={billingInterval} onValueChange={(v) => setBillingInterval(v as BillingInterval | "none")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {BILLING_INTERVALS.map((i) => (
                    <SelectItem key={i} value={i}>
                      {i.charAt(0).toUpperCase() + i.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5" />

            <div className="space-y-1.5">
              <Label className="text-slate-300">Period start <span className="text-slate-500">(optional)</span></Label>
              <Input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-100"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-slate-300">Period end <span className="text-slate-500">(optional)</span></Label>
              <Input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-100"
              />
            </div>
          </div>

          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-amber-500 hover:bg-amber-600 text-black font-semibold"
          >
            {saving ? "Saving…" : "Save subscription"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Entity counts ───────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {Object.entries(counts).map(([entity, count]) => (
          <Card key={entity}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm capitalize text-muted-foreground">{entity}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{count as number}</CardContent>
          </Card>
        ))}
      </div>

      {/* ── Org Settings ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Org Settings</CardTitle>
        </CardHeader>
        <CardContent>
          {settings ? (
            <pre className="text-xs whitespace-pre-wrap bg-muted rounded p-3 overflow-x-auto">
              {JSON.stringify(settings, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">No settings configured.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
