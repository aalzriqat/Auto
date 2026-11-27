import { PERMISSIONS } from "@/convex/utils/permissions";
import { usePermissions } from "@/hooks/use-permissions";

/**
 * SCRUM-961: what the viewer may see of an opening-prepaid-to-employee-advances change. This only decides which
 * queries are worth asking and which controls to show; every backend function re-checks its own authority.
 * - canReclassify: the status, request and approval need both finance and payroll management.
 * - canViewPayroll: the advances list (for the posting date) needs payroll viewing.
 * - canListMembers: the team list (to pick and name employees) needs user viewing.
 */
export function usePrepaidReclassAccess() {
  const { isOwner, hasPermission, membership } = usePermissions();
  return {
    canReclassify: isOwner || (hasPermission(PERMISSIONS.MANAGE_FINANCE) && hasPermission(PERMISSIONS.MANAGE_PAYROLL)),
    canViewPayroll: isOwner || hasPermission(PERMISSIONS.VIEW_PAYROLL),
    canListMembers: isOwner || hasPermission(PERMISSIONS.VIEW_USERS),
    myUserId: membership?.userId ? String(membership.userId) : null,
  };
}
