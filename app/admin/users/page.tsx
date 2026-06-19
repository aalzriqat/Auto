"use client";

import { useState } from "react";
import { usePaginatedQuery, useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";

function ManageUserOrgsDialog({ userId, onClose }: { userId: Id<"users">; onClose: () => void }) {
  const detail = useQuery(api.adminUsers.getUserDetail, { userId });
  const changeUserRole = useMutation(api.adminUsers.changeUserRole);
  const removeMembership = useMutation(api.adminUsers.removeMembership);
  const startImpersonation = useMutation(api.adminImpersonation.startImpersonation);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{detail?.user.email}</DialogTitle>
          <DialogDescription>Manage organization memberships and roles.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {detail?.orgs.map((o) => (
            <OrgMembershipRow
              key={o.membershipId}
              orgName={o.orgName}
              orgId={o.orgId}
              roleName={o.roleName}
              onChangeRole={async (roleId) => { await changeUserRole({ userId, orgId: o.orgId, roleId }); }}
              onRemove={async () => {
                await removeMembership({ userId, orgId: o.orgId });
                toast.success(`Removed from ${o.orgName}`);
              }}
              onImpersonate={async (reason) => {
                await startImpersonation({ targetUserId: userId, orgId: o.orgId, reason });
                toast.success(`Impersonating ${detail?.user.email} in ${o.orgName}`);
                window.open(`/${o.orgId}`, "_blank");
              }}
            />
          ))}
          {detail && detail.orgs.length === 0 && (
            <p className="text-sm text-muted-foreground">No organization memberships.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrgMembershipRow({
  orgName,
  orgId,
  roleName,
  onChangeRole,
  onRemove,
  onImpersonate,
}: {
  orgName: string;
  orgId: Id<"organizations">;
  roleName: string;
  onChangeRole: (roleId: Id<"roles">) => Promise<void>;
  onRemove: () => Promise<void>;
  onImpersonate: (reason: string) => Promise<void>;
}) {
  const roles = useQuery(api.adminUsers.listRolesForOrg, { orgId });
  const [reason, setReason] = useState("");
  const [impersonating, setImpersonating] = useState(false);

  async function handleImpersonate() {
    if (!reason.trim()) {
      toast.error("Enter a reason before impersonating.");
      return;
    }
    setImpersonating(true);
    try {
      await onImpersonate(reason.trim());
      setReason("");
    } catch (e: any) {
      toast.error(e?.data?.message ?? e?.message ?? "Failed to start impersonation");
    } finally {
      setImpersonating(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border rounded-md p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{orgName}</p>
          <p className="text-xs text-muted-foreground">Current role: {roleName}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="text-sm border rounded-md px-2 py-1 bg-background"
            defaultValue=""
            onChange={async (e) => {
              if (!e.target.value) return;
              await onChangeRole(e.target.value as Id<"roles">);
              toast.success(`Role updated for ${orgName}`);
              e.target.value = "";
            }}
          >
            <option value="" disabled>Change role…</option>
            {roles?.map((r) => (
              <option key={r._id} value={r._id}>{r.name}</option>
            ))}
          </select>
          <Button size="sm" variant="destructive" onClick={onRemove}>Remove</Button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          placeholder="Reason for impersonating (required, audited)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="h-8 text-xs"
        />
        <Button size="sm" variant="outline" disabled={impersonating} onClick={handleImpersonate}>
          Impersonate
        </Button>
      </div>
    </div>
  );
}

export default function AdminUsersPage() {
  const { results: users, loadMore, status } = usePaginatedQuery(
    api.adminUsers.listUsers,
    {},
    { initialNumItems: 50 }
  );

  const [deleteTarget, setDeleteTarget] = useState<{ id: Id<"users">; email: string } | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [manageTarget, setManageTarget] = useState<Id<"users"> | null>(null);

  const disableUser = useMutation(api.adminUsers.disableUser);
  const enableUser = useMutation(api.adminUsers.enableUser);
  const deleteUser = useAction(api.adminUsers.deleteUser);

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteUser({ userId: deleteTarget.id, confirmEmail });
      toast.success(`${deleteTarget.email} deleted`);
      setDeleteTarget(null);
      setConfirmEmail("");
    } catch (e: any) {
      toast.error(e?.data?.message ?? e?.message ?? "Delete failed");
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100 mb-4">Users</h1>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Organizations</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-end">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user._id}>
                <TableCell className="font-medium">{user.email}</TableCell>
                <TableCell>{user.name ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {user.orgs.map((o) => (
                      <Badge key={o.orgId} variant="outline">
                        {o.orgName} ({o.roleName})
                      </Badge>
                    ))}
                    {user.orgs.length === 0 && <span className="text-muted-foreground text-xs">No orgs</span>}
                  </div>
                </TableCell>
                <TableCell>
                  {user.disabled ? <Badge variant="destructive">Disabled</Badge> : <Badge variant="secondary">Active</Badge>}
                </TableCell>
                <TableCell className="text-end space-x-2">
                  <Button size="sm" variant="outline" onClick={() => setManageTarget(user._id)}>
                    Manage
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => (user.disabled ? enableUser({ userId: user._id }) : disableUser({ userId: user._id }))}
                  >
                    {user.disabled ? "Enable" : "Disable"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleteTarget({ id: user._id, email: user.email })}>
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

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete {deleteTarget?.email}?</DialogTitle>
            <DialogDescription>
              Deletes the user record, every org membership, and their Clerk account. Type their email to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input placeholder={deleteTarget?.email} value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" disabled={confirmEmail !== deleteTarget?.email} onClick={handleDelete}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-xs text-slate-500 mt-4">
        To impersonate a user, click Manage on their row, enter a reason, and click Impersonate next to the
        organization — opens a new tab with their exact role/permissions, audited, and expires after 30 minutes.
      </p>

      {manageTarget && <ManageUserOrgsDialog userId={manageTarget} onClose={() => setManageTarget(null)} />}
    </div>
  );
}
