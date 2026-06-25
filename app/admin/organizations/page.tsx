"use client";

import { useState } from "react";
import Link from "next/link";
import { usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
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
      <h1 className="text-xl font-semibold text-slate-100 mb-4">Organizations</h1>

      <Card className="overflow-hidden">
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
                  <Link href={`/admin/organizations/${org._id}`} className="hover:underline">
                    {org.name}
                  </Link>
                </TableCell>
                <TableCell>{org.memberCount}</TableCell>
                <TableCell>{new Date(org.createdAt).toLocaleDateString()}</TableCell>
                <TableCell>
                  {org.suspended ? <Badge variant="destructive">Suspended</Badge> : <Badge variant="secondary">Active</Badge>}
                </TableCell>
                <TableCell className="text-end space-x-2">
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
      </Card>

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
