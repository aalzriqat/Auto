"use client";

import { useState } from "react";
import Link from "next/link";
import { usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Building2, ChevronRight } from "lucide-react";
import { PageHeader, TableScroll, EmptyState } from "@/components/admin/ui";

export default function AdminOrganizationsPage() {
  const { results: orgs, loadMore, status } = usePaginatedQuery(
    api.adminOrgs.listOrgs,
    {},
    { initialNumItems: 50 }
  );

  const [suspendTarget, setSuspendTarget] = useState<{ id: Id<"organizations">; name: string; suspended?: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: Id<"organizations">; name: string } | null>(null);
  const [confirmName, setConfirmName] = useState("");

  const suspendOrg = useMutation(api.adminOrgs.suspendOrg);
  const unsuspendOrg = useMutation(api.adminOrgs.unsuspendOrg);
  const hardDeleteOrg = useMutation(api.adminOrgs.hardDeleteOrg);

  async function handleSuspendConfirm() {
    if (!suspendTarget) return;
    try {
      if (suspendTarget.suspended) {
        await unsuspendOrg({ orgId: suspendTarget.id });
        toast.success(`${suspendTarget.name} unsuspended`);
      } else {
        await suspendOrg({ orgId: suspendTarget.id, reason });
        toast.success(`${suspendTarget.name} suspended`);
      }
      setSuspendTarget(null);
      setReason("");
    } catch (e: any) {
      toast.error(e);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    try {
      await hardDeleteOrg({ orgId: deleteTarget.id, confirmName });
      toast.success(`${deleteTarget.name} permanently deleted`);
      setDeleteTarget(null);
      setConfirmName("");
    } catch (e: any) {
      toast.error(e);
    }
  }

  return (
    <div>
      <PageHeader title="Organizations" description="Every dealership tenant on the platform." />

      {/* Desktop table */}
      <TableScroll className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-end">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orgs.map((org) => (
              <TableRow key={org._id}>
                <TableCell className="font-medium">
                  <Link href={`/admin/organizations/${org._id}`} className="text-foreground hover:text-primary hover:underline">
                    {org.name}
                  </Link>
                </TableCell>
                <TableCell className="tabular-nums">{org.memberCount}</TableCell>
                <TableCell className="text-muted-foreground">{new Date(org.createdAt).toLocaleDateString()}</TableCell>
                <TableCell>
                  {org.suspended ? <Badge variant="destructive">Suspended</Badge> : <Badge variant="secondary">Active</Badge>}
                </TableCell>
                <TableCell className="space-x-2 text-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSuspendTarget({ id: org._id, name: org.name, suspended: org.suspended })}
                  >
                    {org.suspended ? "Unsuspend" : "Suspend"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleteTarget({ id: org._id, name: org.name })}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>

      {/* Mobile cards */}
      <div className="flex flex-col gap-3 md:hidden">
        {orgs.length === 0 && (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState icon={Building2} title="No organizations yet." />
          </div>
        )}
        {orgs.map((org) => (
          <div key={org._id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`/admin/organizations/${org._id}`}
                className="group flex min-w-0 items-center gap-1 font-medium text-foreground"
              >
                <span className="truncate">{org.name}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
              {org.suspended ? <Badge variant="destructive">Suspended</Badge> : <Badge variant="secondary">Active</Badge>}
            </div>
            <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
              <span>{org.memberCount} members</span>
              <span>Created {new Date(org.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={() => setSuspendTarget({ id: org._id, name: org.name, suspended: org.suspended })}
              >
                {org.suspended ? "Unsuspend" : "Suspend"}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="flex-1"
                onClick={() => setDeleteTarget({ id: org._id, name: org.name })}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>

      {status === "CanLoadMore" && (
        <Button variant="outline" className="mt-4" onClick={() => loadMore(50)}>
          Load more
        </Button>
      )}

      <Dialog open={!!suspendTarget} onOpenChange={(open) => !open && setSuspendTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{suspendTarget?.suspended ? "Unsuspend" : "Suspend"} {suspendTarget?.name}</DialogTitle>
            <DialogDescription>
              {suspendTarget?.suspended
                ? "Members will regain access to this organization immediately."
                : "Members will be locked out of this organization immediately."}
            </DialogDescription>
          </DialogHeader>
          {!suspendTarget?.suspended && (
            <Input placeholder="Reason (shown in audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSuspendTarget(null)}>Cancel</Button>
            <Button onClick={handleSuspendConfirm}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              This deletes every record belonging to this organization across all tables. This cannot be undone.
              Type the organization name to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input placeholder={deleteTarget?.name} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" disabled={confirmName !== deleteTarget?.name} onClick={handleDeleteConfirm}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
