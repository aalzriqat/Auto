"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useState, useEffect } from "react";
import { PageHeader, StatCard, SectionCard } from "@/components/admin/ui";

const PLANS = ["free", "starter", "professional", "enterprise"] as const;
const STATUSES = ["active", "past_due", "cancelled", "expired"] as const;
const BILLING_INTERVALS = ["monthly", "annual"] as const;

type Plan = (typeof PLANS)[number];
type SubStatus = (typeof STATUSES)[number];
type BillingInterval = (typeof BILLING_INTERVALS)[number];

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  past_due: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  cancelled: "bg-muted text-muted-foreground",
  expired: "bg-destructive/10 text-destructive",
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
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const { org, settings, counts, subscription } = detail;

  return (
    <div className="space-y-5">
      <PageHeader
        title={org.name}
        actions={
          <Button variant="outline" asChild>
            <Link href={`/admin/data?orgId=${orgId}`}>Browse data for this org</Link>
          </Button>
        }
      />
      <div className="-mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Created {new Date(org.createdAt).toLocaleDateString()}</span>
        <span>·</span>
        {org.suspended ? <Badge variant="destructive">Suspended</Badge> : <Badge variant="secondary">Active</Badge>}
      </div>

      {org.suspended && org.suspendedReason && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="pt-6 text-sm text-destructive">
            Suspended reason: {org.suspendedReason}
          </CardContent>
        </Card>
      )}

      {/* ── Subscription Editor ─────────────────────────── */}
      <SectionCard
        title="Subscription"
        action={
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_COLORS[subscription?.status ?? "active"] ?? ""}`}
            >
              {subscription?.status ?? "active"}
            </span>
            <Badge variant="secondary" className="text-xs capitalize">
              {subscription?.plan ?? "free"}
            </Badge>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Plan</Label>
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
              <Label>Status</Label>
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
              <Label>Billing interval <span className="text-muted-foreground">(optional)</span></Label>
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

            <div className="hidden sm:block" />

            <div className="space-y-1.5">
              <Label>Period start <span className="text-muted-foreground">(optional)</span></Label>
              <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label>Period end <span className="text-muted-foreground">(optional)</span></Label>
              <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </div>
          </div>

          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save subscription"}
          </Button>
        </div>
      </SectionCard>

      {/* ── Entity counts ───────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Object.entries(counts).map(([entity, count]) => (
          <StatCard key={entity} label={entity} value={(count as number).toLocaleString()} />
        ))}
      </div>

      {/* ── Org Settings ────────────────────────────────── */}
      <SectionCard title="Org Settings">
        {settings ? (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs text-foreground">
            {JSON.stringify(settings, null, 2)}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No settings configured.</p>
        )}
      </SectionCard>
    </div>
  );
}
