import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Permission, PERMISSIONS } from "@/convex/utils/permissions";

export function usePermissions() {
  const { activeOrgId } = useOrg();

  const membership = useQuery(
    api.memberships.getMyMembership,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const permissions = membership?.permissions || [];
  const isLoading = membership === undefined;
  const isOwner = membership?.roleName === "OWNER";

  const hasPermission = (permission: string) => {
    if (isOwner) return true;
    return permissions.includes(permission);
  };

  const hasAnyPermission = (perms: string[]) => {
    if (isOwner) return true;
    return perms.some(p => permissions.includes(p));
  };

  const hasAllPermissions = (perms: string[]) => {
    if (isOwner) return true;
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
