"use client";

import { useMemo, useState } from "react";
import { useQuery, usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";

const PURGE_PRESETS = [30, 60, 90, 120, 180, 365];
const ALL_ORGS = "__all__";
const PLATFORM = "__platform__";

function locationLabel(v: { country?: string; region?: string; city?: string }): string {
  return [v.city, v.region, v.country].filter(Boolean).join(", ") || "—";
}

export default function AdminAnalyticsPage() {
  const overview = useQuery(api.adminAnalytics.getOverview);
  const { results: orgs } = usePaginatedQuery(api.adminOrgs.listOrgs, {}, { initialNumItems: 200 });
  const orgNameById = useMemo(() => {
    const map = new Map<string, string>();
    orgs.forEach((org) => map.set(org._id, org.name));
    return map;
  }, [orgs]);

  const [orgFilter, setOrgFilter] = useState<string>(ALL_ORGS);
  let scope: "all" | "platform" | Id<"organizations"> = orgFilter as Id<"organizations">;
  if (orgFilter === ALL_ORGS) scope = "all";
  else if (orgFilter === PLATFORM) scope = "platform";

  const { results: visitors, loadMore, status } = usePaginatedQuery(
    api.adminAnalytics.listVisitors,
    { scope },
    { initialNumItems: 50 }
  );

  const [journeyId, setJourneyId] = useState<Id<"siteVisitors"> | null>(null);
  const journey = useQuery(api.adminAnalytics.getVisitorJourney, journeyId ? { siteVisitorId: journeyId } : "skip");

  const purge = useMutation(api.siteVisitors.purgeEventsOlderThan);
  const [purgeDays, setPurgeDays] = useState("90");
  const [purging, setPurging] = useState(false);

  async function handlePurge() {
    const days = Number(purgeDays);
    if (!window.confirm(`Permanently delete all page-view/click events older than ${days} days? This cannot be undone.`)) {
      return;
    }
    setPurging(true);
    try {
      await purge({ olderThanDays: days });
      toast.success(`Started deleting events older than ${days} days.`);
    } catch {
      toast.error("Failed to start deletion. Please try again.");
    } finally {
      setPurging(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100 mb-1">Website Analytics</h1>
      <p className="text-sm text-slate-400 mb-6">
        Visitor traffic for AutoFlow&apos;s own marketing pages and every dealer-site storefront.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">New Visitors Today</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{overview?.newVisitorsToday ?? "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">New Visitors (7d)</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{overview?.newVisitors7d ?? "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Page Views (7d)</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{overview?.pageViews7d ?? "—"}</CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top traffic sources (7d)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {overview?.topTrafficSources.length === 0 && (
              <p className="text-sm text-muted-foreground">No events recorded yet.</p>
            )}
            {overview?.topTrafficSources.map((s) => (
              <div key={s.label} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                <span>{s.label}</span>
                <span className="text-muted-foreground">{s.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top pages (7d)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {overview?.topPages.length === 0 && (
              <p className="text-sm text-muted-foreground">No page views recorded yet.</p>
            )}
            {overview?.topPages.map((p) => (
              <div key={p.path} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                <span className="font-mono text-xs">{p.path}</span>
                <span className="text-muted-foreground">{p.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Data retention</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <p className="text-xs text-slate-500 flex-1">
            Events are kept indefinitely by default. Permanently delete page-view/click events older than:
          </p>
          <Select value={purgeDays} onValueChange={setPurgeDays}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PURGE_PRESETS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="destructive" size="sm" onClick={handlePurge} disabled={purging}>
            Delete
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-100">Visitors</h2>
        <Select value={orgFilter} onValueChange={setOrgFilter}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ORGS}>All sites</SelectItem>
            <SelectItem value={PLATFORM}>AutoFlow marketing site</SelectItem>
            {orgs.map((org) => (
              <SelectItem key={org._id} value={org._id}>
                {org.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>First seen</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Device</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-end">Views / Clicks</TableHead>
              <TableHead className="text-end">Journey</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visitors.map((v) => (
              <TableRow key={v._id}>
                <TableCell className="text-xs whitespace-nowrap">{new Date(v.firstSeenAt).toLocaleString()}</TableCell>
                <TableCell className="text-sm">
                  {v.orgId ? (orgNameById.get(v.orgId) ?? v.host) : "AutoFlow marketing site"}
                </TableCell>
                <TableCell className="text-sm">{v.firstTrafficSource}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {v.deviceType} · {v.browserName} · {v.osName}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {v.geoLookupStatus === "pending" ? "Looking up…" : locationLabel(v)}
                </TableCell>
                <TableCell className="text-end text-sm">
                  {v.pageViewCount} / {v.linkClickCount}
                </TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="outline" onClick={() => setJourneyId(v._id)}>
                    View
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {status === "CanLoadMore" && (
        <Button variant="outline" className="mt-4" onClick={() => loadMore(50)}>
          Load more
        </Button>
      )}

      <Dialog open={!!journeyId} onOpenChange={(open) => !open && setJourneyId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Visitor journey</DialogTitle>
          </DialogHeader>
          {journey && (
            <div className="max-h-[60vh] overflow-y-auto flex flex-col gap-2">
              <p className="text-xs text-muted-foreground mb-1">
                {journey.visitor.deviceType} · {journey.visitor.browserName} · {journey.visitor.osName} ·{" "}
                {locationLabel(journey.visitor)}
              </p>
              {journey.events.map((e) => (
                <div key={e._id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                  <div>
                    <Badge variant={e.type === "page_view" ? "secondary" : "outline"} className="me-2">
                      {e.type === "page_view" ? "View" : "Click"}
                    </Badge>
                    <span className="font-mono text-xs">{e.type === "link_click" ? e.linkTarget : e.path}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
