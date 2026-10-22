"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { AccessDenied } from "@/components/ui/access-denied";

export function RoleGuard({
  children,
  permissions = [],
  anyPermissions,
  ownerOnly = false,
}: {
  children: React.ReactNode;
  permissions?: string[];
  /** At least one queue permission is required, in addition to permissions. */
  anyPermissions?: string[];
  /** When true, only a server-qualified system owner may pass. */
  ownerOnly?: boolean;
}) {
  const { activeOrgId } = useOrg();

  const membership = useQuery(
    api.memberships.getMyMembership,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  // Still resolving org / membership — show a neutral loading state.
  if (!activeOrgId || membership === undefined) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const hasAccess = ownerOnly
    ? membership?.isSystemOwnerRole === true
    : permissions.every((p) => membership?.permissions.includes(p) ?? false) &&
      (anyPermissions === undefined || anyPermissions.some((p) => membership?.permissions.includes(p) ?? false));

  // Instead of silently bouncing the user to the dashboard, show a calm,
  // branded "Access Not Allowed" panel so the restriction is clear and
  // never reads as an error.
  if (!hasAccess) {
    return <AccessDenied variant="page" />;
  }

  return <>{children}</>;
}
