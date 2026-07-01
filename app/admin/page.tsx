"use client";

import { useState, useEffect } from "react";
import { useQuery, usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { X, Plus } from "lucide-react";
import { Doc } from "@/convex/_generated/dataModel";

type WebhookStatus = "received" | "success" | "error" | "dead_letter";

function WebhookStatusBadge({ status }: { status: WebhookStatus }) {
  if (status === "success") return <Badge variant="secondary">OK</Badge>;
  if (status === "received") return <Badge variant="outline">Received</Badge>;
  return <Badge variant="destructive">Error</Badge>;
}

export default function AdminOverviewPage() {
  const overview = useQuery(api.adminSystem.getOverview);
  const cronStatus = useQuery(api.adminSystem.getCronStatus);
  const { results: webhookLogs } = usePaginatedQuery(api.adminSystem.listWebhookLogs, {}, { initialNumItems: 10 });
  const setSiteConfig = useMutation(api.adminSystem.setSiteConfig);

  // showPlanPricing
  const showPricingRaw = useQuery(api.adminSystem.getSiteConfig, { key: "showPlanPricing" });
  const [showPricing, setShowPricing] = useState(true);
  const [pricingSaving, setPricingSaving] = useState(false);

  useEffect(() => {
    if (showPricingRaw !== undefined) {
      setShowPricing(showPricingRaw === null ? true : (showPricingRaw as boolean));
    }
  }, [showPricingRaw]);

  async function handlePricingToggle(val: boolean) {
    setShowPricing(val);
    setPricingSaving(true);
    try {
      await setSiteConfig({ key: "showPlanPricing", value: val });
      toast.success(val ? "Plan pricing is now visible to users" : "Plan pricing is now hidden from users");
    } catch {
      toast.error("Failed to save");
      setShowPricing(!val);
    } finally {
      setPricingSaving(false);
    }
  }

  // supportNotifyEmails
  const notifyEmailsRaw = useQuery(api.adminSystem.getSiteConfig, { key: "supportNotifyEmails" });
  const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [emailsSaving, setEmailsSaving] = useState(false);

  useEffect(() => {
    if (notifyEmailsRaw !== undefined) {
      setNotifyEmails(Array.isArray(notifyEmailsRaw) ? notifyEmailsRaw : []);
    }
  }, [notifyEmailsRaw]);

  async function addNotifyEmail() {
    const email = newEmail.trim().toLowerCase();
    if (!email || notifyEmails.includes(email)) return;
    const updated = [...notifyEmails, email];
    setEmailsSaving(true);
    try {
      await setSiteConfig({ key: "supportNotifyEmails", value: updated });
      setNotifyEmails(updated);
      setNewEmail("");
      toast.success("Email added");
    } catch {
      toast.error("Failed to save");
    } finally {
      setEmailsSaving(false);
    }
  }

  async function removeNotifyEmail(email: string) {
    const updated = notifyEmails.filter((e) => e !== email);
    setEmailsSaving(true);
    try {
      await setSiteConfig({ key: "supportNotifyEmails", value: updated });
      setNotifyEmails(updated);
      toast.success("Email removed");
    } catch {
      toast.error("Failed to save");
    } finally {
      setEmailsSaving(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100 mb-1">Overview</h1>
      <p className="text-sm text-slate-400 mb-6">System-wide stats across every organization.</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {overview &&
          Object.entries(overview).map(([key, count]) => (
            <Card key={key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm capitalize text-muted-foreground">{key}</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{count as number}</CardContent>
            </Card>
          ))}
      </div>

      {/* ── Site Configuration ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Billing Page Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label className="text-slate-300 font-medium">Show Plan Pricing</Label>
                <p className="text-xs text-slate-500 mt-0.5">Display JOD prices on the billing page visible to all users.</p>
              </div>
              <Switch
                checked={showPricing}
                onCheckedChange={handlePricingToggle}
                disabled={pricingSaving}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Support Inbox Notifications</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-slate-500">These emails receive a notification whenever a new message arrives at any @autoflowdealer.com inbox.</p>
            <div className="flex gap-2">
              <Input
                placeholder="name@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addNotifyEmail(); }}
                className="bg-slate-800 border-slate-700 text-slate-100 text-sm"
              />
              <Button size="sm" onClick={addNotifyEmail} disabled={!newEmail.trim() || emailsSaving}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {notifyEmails.length === 0 ? (
              <p className="text-xs text-slate-500">No notification emails configured.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {notifyEmails.map((email) => (
                  <div key={email} className="flex items-center justify-between bg-slate-800 rounded px-3 py-1.5 text-sm">
                    <span className="text-slate-200">{email}</span>
                    <button onClick={() => removeNotifyEmail(email)} className="text-slate-500 hover:text-red-400 transition-colors">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cron jobs</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {cronStatus?.length === 0 && <p className="text-sm text-muted-foreground">No heartbeats recorded yet.</p>}
            {cronStatus?.map((c: Doc<"cronHeartbeats">) => (
              <div key={c.jobName} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                <div>
                  <p className="font-medium">{c.jobName}</p>
                  <p className="text-xs text-muted-foreground">{new Date(c.ranAt).toLocaleString()}</p>
                </div>
                {c.success ? <Badge variant="secondary">OK</Badge> : <Badge variant="destructive">Failed</Badge>}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent webhook deliveries</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {webhookLogs.length === 0 && <p className="text-sm text-muted-foreground">No webhook events yet.</p>}
            {webhookLogs.map((w) => (
              <div key={w._id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                <div>
                  <p className="font-medium">{w.source} · {w.summary}</p>
                  <p className="text-xs text-muted-foreground">{new Date(w.createdAt).toLocaleString()}</p>
                </div>
                <WebhookStatusBadge status={w.status} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-slate-500 mt-6">
        For application error logs and tracing, see the{" "}
        <a href="https://sentry.io" target="_blank" rel="noreferrer" className="underline">
          Sentry dashboard
        </a>
        .
      </p>
    </div>
  );
}
