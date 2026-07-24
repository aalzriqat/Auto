"use client";

import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { History } from "lucide-react";
import { PageHeader, TableScroll, EmptyState } from "@/components/admin/ui";

export default function AdminAuditPage() {
  const { results: entries, loadMore, status } = usePaginatedQuery(
    api.adminAudit.listAuditLog,
    {},
    { initialNumItems: 50 }
  );
  const [detail, setDetail] = useState<(typeof entries)[number] | null>(null);

  return (
    <div>
      <PageHeader title="Audit Log" description="Every super-admin action, newest first." />

      {/* Desktop table */}
      <TableScroll className="hidden md:block">
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
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </TableCell>
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
      </TableScroll>

      {/* Mobile cards */}
      <div className="flex flex-col gap-3 md:hidden">
        {entries.length === 0 && (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState icon={History} title="No audit entries yet." />
          </div>
        )}
        {entries.map((entry) => (
          <button
            key={entry._id}
            onClick={() => setDetail(entry)}
            className="rounded-xl border border-border bg-card p-4 text-start shadow-sm transition-colors hover:bg-muted/50"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">{entry.action}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{entry.actorEmail}</p>
            {entry.targetTable && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {entry.targetTable}{entry.targetId ? ` · ${entry.targetId}` : ""}
              </p>
            )}
          </button>
        ))}
      </div>

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
          <pre className="max-h-[60vh] overflow-x-auto overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs text-foreground">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
