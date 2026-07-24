"use client";

import { useState, useEffect } from "react";
import { useQuery, usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import {
  X,
  Plus,
  Building2,
  Users,
  Car,
  Contact,
  Target,
  Receipt,
  Wallet,
  ClipboardList,
  type LucideIcon,
} from "lucide-react";
import { Doc } from "@/convex/_generated/dataModel";
import { PageHeader, StatCard, SectionCard, EmptyState } from "@/components/admin/ui";

type WebhookStatus = "received" | "success" | "error" | "dead_letter";

function WebhookStatusBadge({ status }: { status: WebhookStatus }) {
  if (status === "success") return <Badge variant="secondary">OK</Badge>;
  if (status === "received") return <Badge variant="outline">Received</Badge>;
  return <Badge variant="destructive">Error</Badge>;
}

const STAT_META: Record<string, { label: string; icon: LucideIcon; tone: "default" | "primary" | "success" | "warning" | "danger" }> = {
  organizations: { label: "Organizations", icon: Building2, tone: "primary" },
  users: { label: "Users", icon: Users, tone: "primary" },
  vehicles: { label: "Vehicles", icon: Car, tone: "default" },
  customers: { label: "Customers", icon: Contact, tone: "default" },
  leads: { label: "Leads", icon: Target, tone: "warning" },
  sales: { label: "Sales", icon: Receipt, tone: "success" },
  expenses: { label: "Expenses", icon: Wallet, tone: "default" },
  tasks: { label: "Tasks", icon: ClipboardList, tone: "default" },
};

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
      <PageHeader title="Dashboard" description="System-wide stats across every organization." />

      {/* KPI tiles */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {overview
          ? Object.entries(overview).map(([key, count]) => {
              const meta = STAT_META[key] ?? { label: key, icon: Building2, tone: "default" as const };
              return (
                <StatCard
                  key={key}
                  label={meta.label}
                  value={(count as number).toLocaleString()}
                  icon={meta.icon}
                  tone={meta.tone}
                />
              );
            })
          : Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-[104px] animate-pulse rounded-xl border border-border bg-card" />
            ))}
      </div>

      {/* Site configuration */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Billing Page Settings">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="font-medium text-foreground">Show Plan Pricing</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Display JOD prices on the billing page visible to all users.
              </p>
            </div>
            <Switch checked={showPricing} onCheckedChange={handlePricingToggle} disabled={pricingSaving} />
          </div>
        </SectionCard>

        <SectionCard title="Support Inbox Notifications">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              These emails receive a notification whenever a new message arrives at any @autoflowdealer.com inbox.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="name@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addNotifyEmail();
                }}
              />
              <Button size="icon" onClick={addNotifyEmail} disabled={!newEmail.trim() || emailsSaving} aria-label="Add email">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {notifyEmails.length === 0 ? (
              <p className="text-xs text-muted-foreground">No notification emails configured.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {notifyEmails.map((email) => (
                  <div
                    key={email}
                    className="flex items-center justify-between rounded-lg bg-muted px-3 py-1.5 text-sm"
                  >
                    <span className="text-foreground">{email}</span>
                    <button
                      onClick={() => removeNotifyEmail(email)}
                      className="text-muted-foreground transition-colors hover:text-destructive"
                      aria-label={`Remove ${email}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {/* System health */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Cron jobs" bodyClassName="p-0">
          {cronStatus?.length === 0 ? (
            <EmptyState title="No heartbeats recorded yet." />
          ) : (
            <ul className="divide-y divide-border">
              {cronStatus?.map((c: Doc<"cronHeartbeats">) => (
                <li key={c.jobName} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{c.jobName}</p>
                    <p className="text-xs text-muted-foreground">{new Date(c.ranAt).toLocaleString()}</p>
                  </div>
                  {c.success ? <Badge variant="secondary">OK</Badge> : <Badge variant="destructive">Failed</Badge>}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Recent webhook deliveries" bodyClassName="p-0">
          {webhookLogs.length === 0 ? (
            <EmptyState title="No webhook events yet." />
          ) : (
            <ul className="divide-y divide-border">
              {webhookLogs.map((w) => (
                <li key={w._id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {w.source} · {w.summary}
                    </p>
                    <p className="text-xs text-muted-foreground">{new Date(w.createdAt).toLocaleString()}</p>
                  </div>
                  <WebhookStatusBadge status={w.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        For application error logs and tracing, see the{" "}
        <a href="https://sentry.io" target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
          Sentry dashboard
        </a>
        .
      </p>
    </div>
  );
}
