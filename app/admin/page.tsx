"use client";

import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function AdminOverviewPage() {
  const overview = useQuery(api.adminSystem.getOverview);
  const cronStatus = useQuery(api.adminSystem.getCronStatus);
  const { results: webhookLogs } = usePaginatedQuery(
    api.adminSystem.listWebhookLogs,
    {},
    { initialNumItems: 10 }
  );

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
              <CardContent className="text-2xl font-semibold">{count}</CardContent>
            </Card>
          ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cron jobs</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {cronStatus?.length === 0 && <p className="text-sm text-muted-foreground">No heartbeats recorded yet.</p>}
            {cronStatus?.map((c) => (
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
                {w.status === "success" ? <Badge variant="secondary">OK</Badge> : <Badge variant="destructive">Error</Badge>}
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
