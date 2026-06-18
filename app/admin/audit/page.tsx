"use client";

import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function AdminAuditPage() {
  const { results: entries, loadMore, status } = usePaginatedQuery(
    api.adminAudit.listAuditLog,
    {},
    { initialNumItems: 50 }
  );
  const [detail, setDetail] = useState<(typeof entries)[number] | null>(null);

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100 mb-4">Audit Log</h1>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead className="text-end">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry._id}>
                <TableCell className="text-xs whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-sm">{entry.actorEmail}</TableCell>
                <TableCell className="text-sm font-medium">{entry.action}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {entry.targetTable ? `${entry.targetTable}${entry.targetId ? ` · ${entry.targetId}` : ""}` : "—"}
                </TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="outline" onClick={() => setDetail(entry)}>View</Button>
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

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail?.action}</DialogTitle>
          </DialogHeader>
          <pre className="text-xs whitespace-pre-wrap bg-muted rounded p-3 overflow-x-auto max-h-[60vh] overflow-y-auto">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
