"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function AdminOrgDetailPage() {
  const params = useParams<{ orgId: string }>();
  const orgId = params.orgId as Id<"organizations">;
  const detail = useQuery(api.adminOrgs.getOrgDetail, { orgId });

  if (!detail) {
    return <p className="text-slate-400 text-sm">Loading...</p>;
  }

  const { org, settings, counts } = detail;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{org.name}</h1>
          <p className="text-sm text-slate-400">
            Created {new Date(org.createdAt).toLocaleDateString()} ·{" "}
            {org.suspended ? <Badge variant="destructive">Suspended</Badge> : <Badge variant="secondary">Active</Badge>}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href={`/admin/data?orgId=${orgId}`}>Browse data for this org</Link>
        </Button>
      </div>

      {org.suspended && org.suspendedReason && (
        <Card className="mb-4 border-red-200">
          <CardContent className="pt-6 text-sm text-red-700">Suspended reason: {org.suspendedReason}</CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
        {Object.entries(counts).map(([entity, count]) => (
          <Card key={entity}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm capitalize text-muted-foreground">{entity}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{count as number}</CardContent>
          </Card>
        ))}
      </div>

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
