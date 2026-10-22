import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";

export function usePermissions() {
  const { activeOrgId } = useOrg();

  const membership = useQuery(
    api.memberships.getMyMembership,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const permissions = membership?.permissions || [];
  const isLoading = membership === undefined;
  const isOwner = membership?.isSystemOwnerRole === true;

  const hasPermission = (permission: string) => {
    return permissions.includes(permission);
  };

  const hasAnyPermission = (perms: string[]) => {
    return perms.some(p => permissions.includes(p));
  };

  const hasAllPermissions = (perms: string[]) => {
    return perms.every(p => permissions.includes(p));
  };

  return {
    permissions,
    isLoading,
    isOwner,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    role: membership?.roleName,
    membership
  };
}
