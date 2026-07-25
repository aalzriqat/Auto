"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { PageHeader, TableScroll } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  const [deletedOnly, setDeletedOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<{ id: string; json: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string } | null>(null);
  // ids to restore (one row, or the whole bulk selection)
  const [restoreTarget, setRestoreTarget] = useState<string[] | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);

  const table = selectedTable || tables?.[0] || "";

  const {
    results: rows,
    loadMore,
    status,
  } = usePaginatedQuery(
    api.adminData.adminListByOrg,
    orgId && table ? { orgId, table, deletedOnly } : "skip",
    { initialNumItems: 25 }
  );

  // Selection is per (org, table, filter) view — reset whenever it changes.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [orgId, table, deletedOnly]);

  const updateRecord = useMutation(api.adminData.adminUpdateRecord);
  const hardDelete = useMutation(api.adminData.adminHardDelete);
  const restoreRecords = useMutation(api.adminData.adminRestoreRecords);

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

  async function handleConfirmRestore() {
    if (!restoreTarget || isRestoring) return;
    setIsRestoring(true);
    try {
      const { restored } = await restoreRecords({ table, ids: restoreTarget });
      toast.success(restored === 1 ? "Record restored to its dealer" : `${restored} records restored to their dealers`);
      setSelectedIds(new Set());
      setRestoreTarget(null);
    } catch (e: any) {
      toast.error(e);
    } finally {
      setIsRestoring(false);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]).filter((k) => k !== "_creationTime") : [];
  const deletedRows = rows.filter((r: any) => r.isDeleted === true);
  const allDeletedSelected = deletedRows.length > 0 && deletedRows.every((r: any) => selectedIds.has(r._id));

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      if (allDeletedSelected) return new Set();
      const next = new Set(prev);
      deletedRows.forEach((r: any) => next.add(r._id));
      return next;
    });
  }

  return (
    <div>
      <PageHeader title="Data Browser" description="Inspect, edit, and restore raw records for any organization." />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <select
          aria-label="Organization"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm sm:w-64"
          value={orgId}
          onChange={(e) => setOrgId(e.target.value as Id<"organizations">)}
        >
          <option value="" disabled>Select organization…</option>
          {orgs.map((o) => (
            <option key={o._id} value={o._id}>{o.name}</option>
          ))}
        </select>

        <select
          aria-label="Table"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm sm:w-56"
          value={table}
          onChange={(e) => setSelectedTable(e.target.value)}
        >
          {tables?.map((t: string) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <Checkbox checked={deletedOnly} onCheckedChange={(v) => setDeletedOnly(v === true)} />
          Deleted only
        </label>
      </div>

      {selectedIds.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
          <span className="text-sm">{selectedIds.size} deleted record{selectedIds.size === 1 ? "" : "s"} selected</span>
          <div className="space-x-2">
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear</Button>
            <Button size="sm" onClick={() => setRestoreTarget(Array.from(selectedIds))}>Restore selected</Button>
          </div>
        </div>
      )}

      {!orgId ? (
        <p className="text-sm text-muted-foreground">Select an organization to browse its data.</p>
      ) : (
        <TableScroll>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={allDeletedSelected}
                    disabled={deletedRows.length === 0}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all deleted rows"
                  />
                </TableHead>
                {columns.map((c) => (
                  <TableHead key={c} className="whitespace-nowrap">{c}</TableHead>
                ))}
                <TableHead className="text-end">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row: any) => {
                const isDeleted = row.isDeleted === true;
                return (
                  <TableRow key={row._id} className={isDeleted ? "opacity-70" : undefined}>
                    <TableCell className="w-8">
                      {isDeleted && (
                        <Checkbox
                          checked={selectedIds.has(row._id)}
                          onCheckedChange={() => toggleSelected(row._id)}
                          aria-label="Select row"
                        />
                      )}
                    </TableCell>
                    {columns.map((c) => (
                      <TableCell key={c} className="max-w-[240px] truncate text-xs">
                        {typeof row[c] === "object" ? JSON.stringify(row[c]) : String(row[c] ?? "")}
                      </TableCell>
                    ))}
                    <TableCell className="text-end space-x-2 whitespace-nowrap">
                      {isDeleted && (
                        <Button size="sm" onClick={() => setRestoreTarget([row._id])}>
                          Restore
                        </Button>
                      )}
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
                );
              })}
            </TableBody>
          </Table>
        </TableScroll>
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

      <Dialog open={!!restoreTarget} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {restoreTarget?.length === 1 ? "Restore this record?" : `Restore ${restoreTarget?.length ?? 0} records?`}
            </DialogTitle>
            <DialogDescription>
              This clears the soft-delete flag so the record reappears in its original dealer&apos;s account. It keeps
              its organization, so it is restored to the exact dealer that owned it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)} disabled={isRestoring}>Cancel</Button>
            <Button onClick={handleConfirmRestore} disabled={isRestoring}>
              {isRestoring ? "Restoring…" : "Restore"}
            </Button>
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
