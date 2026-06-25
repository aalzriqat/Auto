"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";

export default function AdminDataPage() {
  const searchParams = useSearchParams();
  const tables = useQuery(api.adminData.listAdminTables);
  const { results: orgs } = usePaginatedQuery(api.adminOrgs.listOrgs, {}, { initialNumItems: 200 });

  const [orgId, setOrgId] = useState<Id<"organizations"> | "">((searchParams.get("orgId") as Id<"organizations">) || "");
  const [selectedTable, setSelectedTable] = useState<string>("");
  const [editTarget, setEditTarget] = useState<{ id: string; json: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string } | null>(null);

  const table = selectedTable || tables?.[0] || "";

  const {
    results: rows,
    loadMore,
    status,
  } = usePaginatedQuery(
    api.adminData.adminListByOrg,
    orgId && table ? { orgId, table } : "skip",
    { initialNumItems: 25 }
  );

  const updateRecord = useMutation(api.adminData.adminUpdateRecord);
  const hardDelete = useMutation(api.adminData.adminHardDelete);

  async function handleSaveEdit() {
    if (!editTarget) return;
    try {
      const patch = JSON.parse(editTarget.json);
      delete patch._id;
      delete patch._creationTime;
      await updateRecord({ table, id: editTarget.id, patch });
      toast.success("Record updated");
      setEditTarget(null);
    } catch (e: any) {
      toast.error(e);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await hardDelete({ table, id: deleteTarget.id });
      toast.success("Record deleted");
      setDeleteTarget(null);
    } catch (e: any) {
      toast.error(e);
    }
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]).filter((k) => k !== "_creationTime") : [];

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100 mb-4">Data Browser</h1>

      <div className="flex gap-3 mb-4">
        <select
          className="text-sm border rounded-md px-3 py-2 bg-background"
          value={orgId}
          onChange={(e) => setOrgId(e.target.value as Id<"organizations">)}
        >
          <option value="" disabled>Select organization…</option>
          {orgs.map((o) => (
            <option key={o._id} value={o._id}>{o.name}</option>
          ))}
        </select>

        <select className="text-sm border rounded-md px-3 py-2 bg-background" value={table} onChange={(e) => setSelectedTable(e.target.value)}>
          {tables?.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {!orgId ? (
        <p className="text-sm text-slate-400">Select an organization to browse its data.</p>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c} className="whitespace-nowrap">{c}</TableHead>
                ))}
                <TableHead className="text-end">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row: any) => (
                <TableRow key={row._id}>
                  {columns.map((c) => (
                    <TableCell key={c} className="max-w-[240px] truncate text-xs">
                      {typeof row[c] === "object" ? JSON.stringify(row[c]) : String(row[c] ?? "")}
                    </TableCell>
                  ))}
                  <TableCell className="text-end space-x-2 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditTarget({ id: row._id, json: JSON.stringify(row, null, 2) })}
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setDeleteTarget({ id: row._id })}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {status === "CanLoadMore" && (
        <Button variant="outline" className="mt-4" onClick={() => loadMore(25)}>
          Load more
        </Button>
      )}

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit record</DialogTitle>
            <DialogDescription>
              Raw JSON editor — Convex enforces the schema on save, so invalid fields will be rejected.
              {"_id"} and {"_creationTime"} are read-only and stripped automatically.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="font-mono text-xs min-h-[320px]"
            value={editTarget?.json ?? ""}
            onChange={(e) => setEditTarget((t) => (t ? { ...t, json: e.target.value } : t))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete this record?</DialogTitle>
            <DialogDescription>This is a hard delete — it bypasses soft-delete and cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>Delete permanently</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
