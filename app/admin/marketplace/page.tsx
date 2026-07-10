"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { MessageCircle, CheckCircle2, Ban, Car, Eye, ShieldCheck, TrendingDown, Zap, Crown, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildWhatsAppDeepLink } from "@/lib/whatsappDeepLink";

type MarketplaceTier = "FREE_FOUNDING" | "LEAD_PACKAGE" | "FEATURED";

const TIER_LABELS: Record<MarketplaceTier, string> = {
  FREE_FOUNDING: "Founding (free)",
  LEAD_PACKAGE: "Lead Package (paid)",
  FEATURED: "Featured (paid)",
};

type PageView = "requests" | "reports" | "dealers";
type RequestStatus = "OPEN" | "MATCHED" | "FULFILLED" | "EXPIRED" | "SPAM";

const STATUS_TABS: { label: string; value: RequestStatus | undefined }[] = [
  { label: "All", value: undefined },
  { label: "Open", value: "OPEN" },
  { label: "Matched", value: "MATCHED" },
  { label: "Fulfilled", value: "FULFILLED" },
  { label: "Expired", value: "EXPIRED" },
  { label: "Spam", value: "SPAM" },
];

type MatchRow = {
  matchId: Id<"marketplaceRequestMatches">;
  dealerName: string;
  whatsappNumber: string | null;
  notifiedAt: number | null;
};

function MatchActionCell({ match, onSend }: { readonly match: MatchRow; readonly onSend: () => void }) {
  if (match.notifiedAt) {
    return (
      <span className="flex items-center gap-1 text-emerald-400 text-xs">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Sent
      </span>
    );
  }
  if (match.whatsappNumber) {
    return (
      <Button size="sm" variant="outline" onClick={onSend}>
        <MessageCircle className="h-3.5 w-3.5 me-1" />
        Send via WhatsApp
      </Button>
    );
  }
  return <span className="text-xs text-slate-500">No WhatsApp number on file</span>;
}

function buildDealerMessage(request: {
  buyerFirstName: string;
  buyerCity: string;
  make?: string;
  model?: string;
  paymentType: string;
  buyerIntent: string;
}) {
  const vehicle = [request.make, request.model].filter(Boolean).join(" ") || "a vehicle";
  return `AutoFlow: buyer ${request.buyerFirstName} in ${request.buyerCity} is looking for ${vehicle} (${request.paymentType}, ${request.buyerIntent} intent). Reply here if you have a match.`;
}

type WeeklyReport = {
  pageViews: number;
  vehicleDetailViews: number;
  requestsMatched: number;
  responsesSent: number;
  avgResponseMinutes: number | null;
  mostViewedVehicle: { make: string; model: string; year: number; views: number } | null;
  requestsLost: number;
};

function buildWeeklyReportMessage(dealerName: string, report: WeeklyReport): string {
  const lines = [
    `AutoFlow weekly marketplace report for ${dealerName}:`,
    `- ${report.requestsMatched} buyer request(s) matched to you`,
    `- ${report.responsesSent} response(s) you sent`,
    report.avgResponseMinutes != null ? `- Avg. response time: ${Math.round(report.avgResponseMinutes)} min` : null,
    `- ${report.pageViews} dealer-site views (${report.vehicleDetailViews} on vehicle pages)`,
    report.mostViewedVehicle
      ? `- Most viewed: ${report.mostViewedVehicle.year} ${report.mostViewedVehicle.make} ${report.mostViewedVehicle.model} (${report.mostViewedVehicle.views} views)`
      : null,
    report.requestsLost > 0 ? `- ${report.requestsLost} request(s) lost to no response — reply faster to win more` : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function WeeklyReportActionCell({
  orgId,
  whatsappNumber,
  sentAt,
  message,
  onSend,
}: {
  readonly orgId: Id<"organizations">;
  readonly whatsappNumber: string | null;
  readonly sentAt: number | null;
  readonly message: string;
  readonly onSend: (orgId: Id<"organizations">, phone: string, message: string) => void;
}) {
  if (sentAt) {
    return (
      <span className="flex items-center gap-1 text-emerald-400 text-xs">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Sent {new Date(sentAt).toLocaleDateString()}
      </span>
    );
  }
  if (whatsappNumber) {
    return (
      <Button size="sm" variant="outline" onClick={() => onSend(orgId, whatsappNumber, message)}>
        <MessageCircle className="h-3.5 w-3.5 me-1" />
        Send via WhatsApp
      </Button>
    );
  }
  return <span className="text-xs text-slate-500">No WhatsApp number on file</span>;
}

function WeeklyReportsView() {
  const reports = useQuery(api.adminMarketplace.listWeeklyReports, {});
  const markSent = useMutation(api.adminMarketplace.markWeeklyReportSentViaWhatsApp);

  async function handleSend(orgId: Id<"organizations">, phone: string, message: string) {
    window.open(buildWhatsAppDeepLink(phone, message), "_blank", "noopener,noreferrer");
    try {
      await markSent({ orgId });
    } catch {
      toast.error("Opened WhatsApp, but failed to record the send.");
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Trailing 7-day activity for opted-in dealers. Automated email goes out every Monday; this is for a manual
        WhatsApp nudge in between, same wa.me pattern as buyer requests.
      </p>
      {reports === undefined && <p className="text-sm text-slate-400">Loading...</p>}
      {reports?.length === 0 && <p className="text-sm text-slate-400">No dealers with activity this week.</p>}

      {(reports ?? []).map((row) => (
        <Card key={row.orgId} className="p-4 bg-slate-900 border-slate-800 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <span className="font-semibold text-slate-100">{row.dealerName}</span>
            <WeeklyReportActionCell
              orgId={row.orgId}
              whatsappNumber={row.whatsappNumber}
              sentAt={row.sentAt}
              message={buildWeeklyReportMessage(row.dealerName, row.report)}
              onSend={handleSend}
            />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-400">
            <span>{row.report.requestsMatched} matched</span>
            <span>{row.report.responsesSent} responses</span>
            {row.report.avgResponseMinutes != null && <span>{Math.round(row.report.avgResponseMinutes)} min avg reply</span>}
            <span className="flex items-center gap-1">
              <Eye className="h-3.5 w-3.5" />
              {row.report.pageViews} views ({row.report.vehicleDetailViews} vehicle)
            </span>
            {row.report.requestsLost > 0 && (
              <span className="flex items-center gap-1 text-amber-400">
                <TrendingDown className="h-3.5 w-3.5" />
                {row.report.requestsLost} lost to no response
              </span>
            )}
          </div>
          {row.report.mostViewedVehicle && (
            <p className="text-xs text-slate-500">
              Most viewed: {row.report.mostViewedVehicle.year} {row.report.mostViewedVehicle.make}{" "}
              {row.report.mostViewedVehicle.model} ({row.report.mostViewedVehicle.views} views)
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}

type DealerRow = {
  orgId: Id<"organizations">;
  tier: MarketplaceTier;
  leadQuota: number | null;
  leadsUsedThisPeriod: number;
  foundingWindowEndsAt: number | null;
};

function TierEditor({ dealer }: { readonly dealer: DealerRow }) {
  const updateTier = useMutation(api.adminMarketplace.updateMarketplaceTier);
  const [tier, setTier] = useState<MarketplaceTier>(dealer.tier);
  const [leadQuota, setLeadQuota] = useState(String(dealer.leadQuota ?? ""));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await updateTier({
        orgId: dealer.orgId,
        tier,
        leadQuota: tier === "LEAD_PACKAGE" && leadQuota.trim() ? Number(leadQuota) : undefined,
      });
      toast.success("Marketplace tier updated.");
    } catch (error: any) {
      toast.error(error?.message?.replace(/^\[.*?\]\s*/, "") || "Failed to update tier — check the dealer's AutoFlow plan includes this feature.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={tier} onValueChange={(value) => setTier(value as MarketplaceTier)}>
        <SelectTrigger className="w-44 h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(TIER_LABELS) as MarketplaceTier[]).map((value) => (
            <SelectItem key={value} value={value}>
              {TIER_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {tier === "LEAD_PACKAGE" && (
        <Input
          type="number"
          min={0}
          className="w-24 h-8 text-xs"
          placeholder="Quota"
          value={leadQuota}
          onChange={(e) => setLeadQuota(e.target.value)}
        />
      )}
      <Button size="sm" variant="outline" disabled={saving} onClick={handleSave}>
        Save
      </Button>
    </div>
  );
}

function DealersView() {
  const dealers = useQuery(api.adminMarketplace.listDealerProfiles, {});
  const verifyPhone = useMutation(api.adminMarketplace.verifyDealerPhone);

  async function handleVerify(orgId: Id<"organizations">) {
    try {
      await verifyPhone({ orgId });
      toast.success("Marked phone verified.");
    } catch {
      toast.error("Failed to mark phone verified.");
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Confirm a dealer&apos;s WhatsApp number by calling or messaging it directly, then mark it verified here — there&apos;s no
        automated OTP send yet (blocked on Meta Business Verification, master plan A5b). Marketplace tier controls Phase 63
        monetization — LEAD_PACKAGE/FEATURED require the dealer&apos;s AutoFlow plan to include that feature.
      </p>
      {dealers === undefined && <p className="text-sm text-slate-400">Loading...</p>}
      {dealers?.length === 0 && <p className="text-sm text-slate-400">No opted-in dealers.</p>}

      {(dealers ?? []).map((dealer) => (
        <Card key={dealer.orgId} className="p-4 bg-slate-900 border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-slate-100">{dealer.dealershipName}</span>
              <span className="text-sm text-slate-400">{dealer.whatsappNumber ?? "No WhatsApp number on file"}</span>
              {dealer.badges.includes("FAST_RESPONSE") && (
                <Badge variant="outline" className="text-[10px] border-amber-600 text-amber-400">
                  <Zap className="h-3 w-3 me-1" />
                  Fast response
                </Badge>
              )}
              {dealer.tier === "FEATURED" && (
                <Badge variant="outline" className="text-[10px] border-yellow-500 text-yellow-400">
                  <Crown className="h-3 w-3 me-1" />
                  Featured
                </Badge>
              )}
              {dealer.tier === "LEAD_PACKAGE" && (
                <Badge variant="outline" className="text-[10px] border-sky-600 text-sky-400">
                  <Package className="h-3 w-3 me-1" />
                  {dealer.leadsUsedThisPeriod}/{dealer.leadQuota ?? 0} leads
                </Badge>
              )}
              {dealer.tier === "FREE_FOUNDING" && dealer.foundingWindowEndsAt != null && (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    dealer.foundingWindowEndsAt < Date.now()
                      ? "border-red-600 text-red-400"
                      : "border-slate-600 text-slate-400"
                  )}
                >
                  {dealer.foundingWindowEndsAt < Date.now()
                    ? "Founding window ended"
                    : `Founding until ${new Date(dealer.foundingWindowEndsAt).toLocaleDateString()}`}
                </Badge>
              )}
            </div>
            {dealer.phoneVerifiedAt ? (
              <span className="flex items-center gap-1 text-emerald-400 text-xs">
                <ShieldCheck className="h-3.5 w-3.5" />
                Verified {new Date(dealer.phoneVerifiedAt).toLocaleDateString()}
              </span>
            ) : dealer.whatsappNumber ? (
              <Button size="sm" variant="outline" onClick={() => handleVerify(dealer.orgId)}>
                <ShieldCheck className="h-3.5 w-3.5 me-1" />
                Mark phone verified
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-slate-500">
            {dealer.totalResponses} response(s)
            {dealer.avgResponseMinutes != null ? ` · ${Math.round(dealer.avgResponseMinutes)} min avg reply` : ""}
          </p>
          <TierEditor dealer={dealer} />
        </Card>
      ))}
    </div>
  );
}

export default function AdminMarketplacePage() {
  const [view, setView] = useState<PageView>("requests");
  const [statusFilter, setStatusFilter] = useState<RequestStatus | undefined>(undefined);
  const requests = useQuery(api.adminMarketplace.listRequests, { status: statusFilter });
  const markMatchNotified = useMutation(api.adminMarketplace.markMatchNotified);
  const markSpam = useMutation(api.adminMarketplace.markSpam);

  async function handleSend(matchId: Id<"marketplaceRequestMatches">, phone: string, message: string) {
    window.open(buildWhatsAppDeepLink(phone, message), "_blank", "noopener,noreferrer");
    try {
      await markMatchNotified({ matchId });
    } catch {
      toast.error("Opened WhatsApp, but failed to record the notification timestamp.");
    }
  }

  async function handleMarkSpam(requestId: Id<"marketplaceRequests">) {
    try {
      await markSpam({ requestId });
      toast.success("Marked as spam.");
    } catch {
      toast.error("Failed to mark as spam.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Marketplace</h1>
        <p className="text-sm text-slate-400 mt-1">
          Buyer car requests, matched dealers, and weekly proof reports. Send via WhatsApp per master plan §0.5 — manual, no Meta API dependency.
        </p>
      </div>

      <div className="flex gap-2 border-b border-slate-800 pb-3">
        <Button size="sm" variant={view === "requests" ? "default" : "outline"} onClick={() => setView("requests")}>
          Requests
        </Button>
        <Button size="sm" variant={view === "reports" ? "default" : "outline"} onClick={() => setView("reports")}>
          Weekly Reports
        </Button>
        <Button size="sm" variant={view === "dealers" ? "default" : "outline"} onClick={() => setView("dealers")}>
          Dealers
        </Button>
      </div>

      {view === "reports" && <WeeklyReportsView />}
      {view === "dealers" && <DealersView />}

      {view === "requests" && (
        <>
          <div className="flex gap-2">
            {STATUS_TABS.map((tab) => (
              <Button
                key={tab.label}
                size="sm"
                variant={statusFilter === tab.value ? "default" : "outline"}
                onClick={() => setStatusFilter(tab.value)}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          <div className="space-y-4">
            {requests === undefined && <p className="text-sm text-slate-400">Loading...</p>}
            {requests?.length === 0 && <p className="text-sm text-slate-400">No requests.</p>}

        {(requests ?? []).map((request) => (
          <Card key={request._id} className="p-4 bg-slate-900 border-slate-800 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-100">{request.buyerFirstName}</span>
                  <span className="text-sm text-slate-400">{request.buyerPhone}</span>
                  <Badge variant="outline" className="text-[10px] border-slate-600 text-slate-300">
                    {request.status}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      request.buyerIntent === "HOT" && "border-rose-600 text-rose-400",
                      request.buyerIntent === "WARM" && "border-amber-600 text-amber-400",
                      request.buyerIntent === "COLD" && "border-slate-600 text-slate-400"
                    )}
                  >
                    {request.buyerIntent}
                  </Badge>
                </div>
                <p className="text-sm text-slate-400 mt-1 flex items-center gap-1">
                  <Car className="h-3.5 w-3.5" />
                  {[request.make, request.model].filter(Boolean).join(" ") || "Any vehicle"} · {request.buyerCity} ·{" "}
                  {request.paymentType} · {request.buyerTimeframe}
                </p>
              </div>
              {request.status !== "SPAM" && (
                <Button size="sm" variant="ghost" onClick={() => handleMarkSpam(request._id)}>
                  <Ban className="h-3.5 w-3.5 me-1" />
                  Mark spam
                </Button>
              )}
            </div>

            {request.matches.length > 0 && (
              <div className="border-t border-slate-800 pt-3 space-y-2">
                {request.matches.map((match) => (
                  <div key={match.matchId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-slate-200">{match.dealerName}</span>
                    <MatchActionCell
                      match={match}
                      onSend={() =>
                        handleSend(match.matchId, match.whatsappNumber!, buildDealerMessage(request))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
          </div>
        </>
      )}
    </div>
  );
}
