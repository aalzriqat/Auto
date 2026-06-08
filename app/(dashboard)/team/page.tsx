"use client";

import { useState } from "react";
import { useQuery, useMutation, useAction, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EditRoleDialog } from "@/components/team/EditRoleDialog";
import { ChangeMemberRoleDialog } from "@/components/team/ChangeMemberRoleDialog";
import { RoleGuard } from "@/components/auth/RoleGuard";

export default function TeamPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const { results: memberships } = usePaginatedQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });
  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const roles = useQuery(api.roles.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  const removeMember = useAction(api.memberships.remove);
  const createRole = useMutation(api.roles.create);
  const deleteRole = useMutation(api.roles.remove);

  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [memberToDelete, setMemberToDelete] = useState<any>(null);
  const [memberToChangeRole, setMemberToChangeRole] = useState<any>(null);
  const [roleToEdit, setRoleToEdit] = useState<any>(null);

  const isOwner = myMembership?.roleName === "OWNER";
  const canManageUsers = myMembership?.permissions.includes("manage:users") || myMembership?.permissions.includes("MANAGE_USERS") || isOwner;

  const handleDelete = async () => {
    if (!activeOrgId || !memberToDelete) return;
    try {
      await removeMember({ orgId: activeOrgId, membershipId: memberToDelete._id });
      toast.success(t("MemberRemovedSuccess" as any));
      setMemberToDelete(null);
    } catch (error: any) {
      toast.error(error.message || t("MemberRemoveFail" as any));
    }
  };

  return (
    <RoleGuard permissions={["view:users"]}>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        {canManageUsers && (
          <Button onClick={() => setIsInviteOpen(true)}>
            <Plus className="me-2 h-4 w-4" /> {t("AddMember" as any)}
          </Button>
        )}
      </div>

      <Tabs defaultValue="members" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="members">{t("Members" as any)}</TabsTrigger>
          {canManageUsers && <TabsTrigger value="roles">{t("RolesPermissions" as any)}</TabsTrigger>}
        </TabsList>

        <TabsContent value="members">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Member" as any)}</TableHead>
                  <TableHead>{t("Role" as any)}</TableHead>
                  {canManageUsers && <TableHead className="text-end">{t("Actions" as any)}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberships === undefined ? (
                  <TableRow>
                    <TableCell colSpan={canManageUsers ? 3 : 2} className="text-center py-8 text-muted-foreground">
                      {t("LoadingTeam" as any)}
                    </TableCell>
                  </TableRow>
                ) : memberships.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canManageUsers ? 3 : 2} className="text-center py-8 text-muted-foreground">
                      {t("NoTeamMembersFound" as any)}
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
                            {t(member.roleName as any) || member.roleName}
                          </Badge>
                          {member.roleName === "OWNER" && (
                            <ShieldAlert className="h-4 w-4 text-primary" />
                          )}
                        </div>
                      </TableCell>

                      {canManageUsers && (
                        <TableCell className="text-end">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setMemberToChangeRole(member)}
                              disabled={member.roleName === "OWNER" && member.userId === myMembership?.userId}
                            >
                              {t("ChangeRole" as any)}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setMemberToDelete(member)}
                              disabled={member.roleName === "OWNER" && member.userId === myMembership?.userId}
                              title={member.roleName === "OWNER" && member.userId === myMembership?.userId ? t("YouCannotRemoveYourself" as any) : t("RemoveMember" as any)}
                            >
                              <Trash2 className={`h-4 w-4 ${member.roleName === "OWNER" && member.userId === myMembership?.userId ? "text-muted-foreground opacity-50" : "text-red-500"}`} />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {canManageUsers && (
          <TabsContent value="roles">
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Role" as any)}</TableHead>
                    <TableHead>{t("PermissionsCount" as any)}</TableHead>
                    <TableHead className="text-end">{t("Actions" as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roles === undefined ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                        {t("LoadingRoles" as any)}
                      </TableCell>
                    </TableRow>
                  ) : roles.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                        {t("NoRolesFound" as any)}
                      </TableCell>
                    </TableRow>
                  ) : (
                    roles.map((role) => (
                      <TableRow key={role._id}>
                        <TableCell className="font-medium">
                          {t(role.name as any) || role.name}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{role.permissions.length} {t("Allowed" as any)}</Badge>
                        </TableCell>
                        <TableCell className="text-end">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRoleToEdit(role)}
                          >
                            {t("EditPermissions" as any)}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        )}
      </Tabs>

      <InviteMemberDialog
        open={isInviteOpen}
        onOpenChange={setIsInviteOpen}
      />

      {roleToEdit && (
        <EditRoleDialog
          role={roleToEdit}
          open={!!roleToEdit}
          onOpenChange={(open) => !open && setRoleToEdit(null)}
        />
      )}

      {memberToChangeRole && (
        <ChangeMemberRoleDialog
          member={memberToChangeRole}
          open={!!memberToChangeRole}
          onOpenChange={(open) => !open && setMemberToChangeRole(null)}
        />
      )}

      <Dialog open={!!memberToDelete} onOpenChange={(open) => !open && setMemberToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("RemoveTeamMember" as any)}</DialogTitle>
            <DialogDescription>
              {(t("RemoveMemberConfirm" as any)).replace("{0}", memberToDelete?.userName || "")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMemberToDelete(null)}>
              {t("Cancel" as any)}
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              {t("Delete" as any)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </RoleGuard>
  );
}
