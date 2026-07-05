"use client";

import { useState, useRef } from "react";
import { useQuery, useMutation, useAction, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InviteMemberDialog } from "@/components/team/InviteMemberDialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, ShieldAlert, Pencil, Check, X, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EditRoleDialog } from "@/components/team/EditRoleDialog";
import { ChangeMemberRoleDialog } from "@/components/team/ChangeMemberRoleDialog";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { useTableControls } from "@/hooks/useTableControls";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";

// lastSeenAt is throttled to a write at most every few minutes (see
// memberships.touchLastSeen), so "active now" below lines up with that
// window rather than claiming second-by-second accuracy.
function getLastSeenInfo(t: (key: any) => string, lastSeenAt: number | undefined) {
  if (!lastSeenAt) {
    return { label: t("Offline"), dotClass: "bg-muted-foreground/30" };
  }
  const minutes = Math.floor((Date.now() - lastSeenAt) / 60_000);
  if (minutes < 5) {
    return { label: t("ActiveNow"), dotClass: "bg-green-500" };
  }
  if (minutes < 60) {
    return { label: t("ActiveMinutesAgo").replace("{0}", String(minutes)), dotClass: "bg-amber-500" };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { label: t("ActiveHoursAgo").replace("{0}", String(hours)), dotClass: "bg-muted-foreground/40" };
  }
  const days = Math.floor(hours / 24);
  return { label: t("ActiveDaysAgo").replace("{0}", String(days)), dotClass: "bg-muted-foreground/30" };
}

export default function TeamPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const { results: memberships, status: membershipsStatus, loadMore: loadMoreMemberships } = usePaginatedQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });
  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const orgSettings = useQuery(api.orgSettings.get, activeOrgId ? { orgId: activeOrgId } : "skip");
  const roles = useQuery(api.roles.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const commissionMode = orgSettings?.commissionMode ?? "AUTO_MEMBER";

  const removeMember = useAction(api.memberships.remove);
  const updateCommissionRate = useMutation(api.memberships.updateCommissionRate);
  const syncRolePermissions = useMutation(api.memberships.syncRolePermissionsToTemplate);
  const createRole = useMutation(api.roles.create);
  const deleteRole = useMutation(api.roles.remove);

  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [memberToDelete, setMemberToDelete] = useState<any>(null);
  const [memberToChangeRole, setMemberToChangeRole] = useState<any>(null);
  const [roleToEdit, setRoleToEdit] = useState<any>(null);
  const [editingCommission, setEditingCommission] = useState<string | null>(null);
  const [commissionDraft, setCommissionDraft] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");

  const {
    search: searchQuery,
    setSearch: setSearchQuery,
    sortKey,
    sortDir,
    toggleSort,
    rows: sortedMemberships,
  } = useTableControls({
    data: memberships,
    searchFields: (m) => [m.userName, m.userEmail],
    sortAccessors: {
      name: (m) => m.userName.toLowerCase(),
      role: (m) => m.roleName,
      lastSeen: (m) => (m as any).lastSeenAt ?? 0,
    },
    pagination: { status: membershipsStatus, loadMore: loadMoreMemberships, batchSize: 100 },
  });

  const roleOptions = Array.from(new Set((memberships ?? []).map((m) => m.roleName)));

  const filteredMemberships = sortedMemberships?.filter((m) => roleFilter === "ALL" || m.roleName === roleFilter);

  async function handleSaveCommission(membershipId: string) {
    if (!activeOrgId) return;
    const rate = parseFloat(commissionDraft);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      toast.error("Commission rate must be between 0 and 100.");
      return;
    }
    try {
      await updateCommissionRate({ orgId: activeOrgId, membershipId: membershipId as Id<"memberships">, commissionRate: rate });
      toast.success("Commission rate updated.");
    } catch (e: any) {
      toast.error(e);
    }
    setEditingCommission(null);
  }

  const isOwner = myMembership?.roleName === "OWNER";
  const canManageUsers = myMembership?.permissions.includes("manage:users") || myMembership?.permissions.includes("MANAGE_USERS") || isOwner;

  const handleDelete = async () => {
    if (!activeOrgId || !memberToDelete) return;
    try {
      await removeMember({ orgId: activeOrgId, membershipId: memberToDelete._id });
      toast.success(t("MemberRemovedSuccess" as any));
      setMemberToDelete(null);
    } catch (error: any) {
      toast.error(error);
    }
  };

  return (
    <RoleGuard permissions={["view:users"]}>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        {canManageUsers && (
          <div className="flex gap-2">
            {isOwner && (
              <Button
                variant="outline"
                onClick={async () => {
                  if (!activeOrgId) return;
                  try {
                    const n = await syncRolePermissions({ orgId: activeOrgId });
                    toast.success(`Synced ${n} roles to latest permission templates.`);
                  } catch (e: any) {
                    toast.error(e);
                  }
                }}
              >
                <RefreshCw className="me-2 h-4 w-4" /> {t("SyncRolePermissions" as any)}
              </Button>
            )}
            <Button onClick={() => setIsInviteOpen(true)}>
              <Plus className="me-2 h-4 w-4" /> {t("AddMember" as any)}
            </Button>
          </div>
        )}
      </div>

      <Tabs defaultValue="members" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="members">{t("Members" as any)}</TabsTrigger>
          {isOwner && <TabsTrigger value="roles">{t("RolesPermissions" as any)}</TabsTrigger>}
        </TabsList>

        <TabsContent value="members">
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <div className="flex items-center w-full max-w-sm space-x-2 relative">
              <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
              <Input
                placeholder={t("Search" as any)}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ps-9"
              />
            </div>
            {roleOptions.length > 0 && (
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue placeholder={t("Role" as any)} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("AllRoles" as any)}</SelectItem>
                  {roleOptions.map((role) => (
                    <SelectItem key={role} value={role}>{t(role as any) || role}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableColumnHeader label={t("Member" as any)} sortKey="name" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableColumnHeader label={t("Role" as any)} sortKey="role" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableColumnHeader label={t("LastSeen" as any)} sortKey="lastSeen" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <TableHead>
                    <div className="flex items-center gap-1.5">
                      {t("CommissionPct" as any)}
                      {commissionMode === "AUTO_MEMBER" ? (
                        <span className="text-[9px] font-semibold uppercase tracking-wide text-primary bg-primary/10 rounded px-1 py-0.5 leading-none">
                          {t("CommissionModeActive" as any)}
                        </span>
                      ) : (
                        <span className="text-[9px] text-muted-foreground uppercase tracking-wide">
                          ({t("CommissionModeAutoMember" as any)})
                        </span>
                      )}
                    </div>
                  </TableHead>
                  {canManageUsers && <TableHead className="text-end">{t("Actions" as any)}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMemberships === undefined ? (
                  <TableRow>
                    <TableCell colSpan={canManageUsers ? 5 : 4} className="text-center py-8 text-muted-foreground">
                      {t("LoadingTeam" as any)}
                    </TableCell>
                  </TableRow>
                ) : filteredMemberships.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canManageUsers ? 5 : 4} className="text-center py-8 text-muted-foreground">
                      {t("NoTeamMembersFound" as any)}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredMemberships.map((member) => (
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

                      <TableCell>
                        {(() => {
                          const { label, dotClass } = getLastSeenInfo(t, (member as any).lastSeenAt);
                          return (
                            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                              <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                              {label}
                            </div>
                          );
                        })()}
                      </TableCell>

                      <TableCell>
                        {editingCommission === member._id ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.5"
                              className="w-16 border rounded px-2 py-1 text-sm"
                              value={commissionDraft}
                              onChange={e => setCommissionDraft(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter") handleSaveCommission(member._id);
                                if (e.key === "Escape") setEditingCommission(null);
                              }}
                              autoFocus
                            />
                            <span className="text-sm text-muted-foreground">%</span>
                            <button onClick={() => handleSaveCommission(member._id)} className="text-green-600 hover:text-green-700 p-1">
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setEditingCommission(null)} className="text-muted-foreground hover:text-foreground p-1">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 group">
                            <span className="text-sm tabular-nums">
                              {(member as any).commissionRate > 0 ? `${(member as any).commissionRate}%` : <span className="text-muted-foreground">—</span>}
                            </span>
                            {canManageUsers && (
                              <button
                                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                                onClick={() => {
                                  setEditingCommission(member._id);
                                  setCommissionDraft(String((member as any).commissionRate ?? 0));
                                }}
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        )}
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

        {isOwner && (
          <TabsContent value="roles">
            <div className="rounded-md border overflow-x-auto">
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
                    roles.map((role: Doc<"roles">) => (
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
