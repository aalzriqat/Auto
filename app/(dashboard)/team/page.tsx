"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { InviteMemberDialog } from "@/components/team/InviteMemberDialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
// Removed Avatar import

export default function TeamPage() {
  const { activeOrgId } = useOrg();
  
  const memberships = useQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  
  const removeMember = useMutation(api.memberships.remove);

  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [memberToDelete, setMemberToDelete] = useState<any>(null);

  const isOwner = myMembership?.roleName === "OWNER";
  const canManageUsers = myMembership?.permissions.includes("MANAGE_USERS") || isOwner;

  const handleDelete = async () => {
    if (!activeOrgId || !memberToDelete) return;
    try {
      await removeMember({ orgId: activeOrgId, membershipId: memberToDelete._id });
      toast.success("Team member removed successfully");
      setMemberToDelete(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to remove member");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Team Management</h2>
          <p className="text-muted-foreground">
            Manage your dealership staff and their access roles.
          </p>
        </div>
        {canManageUsers && (
          <Button onClick={() => setIsInviteOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add Member
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              {canManageUsers && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {memberships === undefined ? (
              <TableRow>
                <TableCell colSpan={canManageUsers ? 3 : 2} className="text-center py-8 text-muted-foreground">
                  Loading team...
                </TableCell>
              </TableRow>
            ) : memberships.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canManageUsers ? 3 : 2} className="text-center py-8 text-muted-foreground">
                  No team members found.
                </TableCell>
              </TableRow>
            ) : (
              memberships.map((member) => (
                <TableRow key={member._id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center font-medium">
                        {member.userName.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-medium">{member.userName}</span>
                        <span className="text-xs text-muted-foreground">{member.userEmail}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant={member.roleName === "OWNER" ? "default" : "secondary"}>
                        {member.roleName}
                      </Badge>
                      {member.roleName === "OWNER" && (
                        <ShieldAlert className="h-4 w-4 text-primary" />
                      )}
                    </div>
                  </TableCell>
                  
                  {canManageUsers && (
                    <TableCell className="text-right">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => setMemberToDelete(member)}
                        disabled={member.roleName === "OWNER" && member.userId === myMembership?.userId}
                        title={member.roleName === "OWNER" && member.userId === myMembership?.userId ? "You cannot remove yourself" : "Remove member"}
                      >
                        <Trash2 className={`h-4 w-4 ${member.roleName === "OWNER" && member.userId === myMembership?.userId ? "text-muted-foreground opacity-50" : "text-red-500"}`} />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <InviteMemberDialog
        open={isInviteOpen}
        onOpenChange={setIsInviteOpen}
      />

      <Dialog open={!!memberToDelete} onOpenChange={(open) => !open && setMemberToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Team Member</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove {memberToDelete?.userName} from the organization?
              They will lose all access immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMemberToDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
